/**
 * THE PORTABLE SCORE PACKAGE: ONE ARCHIVE, BYTE-STABLE, THAT ANY DAW OR PERSON
 * CAN OPEN AND FILM ENGINE CAN READ BACK.
 *
 * MUS-015. The interchange baseline the epic puts before any DAW adapter
 * ("portable interchange first"): a versioned, DAW-neutral `manifest.json`
 * beside equal-length, aligned 48 kHz / 24-bit Broadcast WAV stems rendered
 * from the session itself, the master, and the reference picture when the
 * film has one.
 *
 * THE STEMS ARE THE SESSION'S OWN BOUNCE. The package does not render its
 * own mix: it takes the instrument-mode bounce whose fingerprint matches the
 * session as it stands (MUS-008), rendering one only when there is none. The
 * bounce is already the one statement of what the session sounds like, and a
 * package rendered differently would be a second one that disagrees. Each
 * stem gains a `bext` chunk (EBU Tech 3285) whose time reference is 0 — the
 * session start — and whose description leads with the stem's matching key,
 * so a DAW that spots by BWF timestamp lines every stem up without being told.
 *
 * DETERMINISTIC. The same session packages to the same bytes: stored (not
 * compressed) entries in sorted order, a fixed DOS date and time, a manifest
 * written with sorted keys and nothing that varies with the clock — the BWF
 * origination stamp is the bounce's own completion time, not the build's. A
 * rebuild of an unchanged session finds the package it already made by hash
 * and registers nothing new.
 *
 * ROUND-TRIP MATCHING. Every session, track, clip, marker and stem carries a
 * stable key (`fe:track:<id>` …). Importing a package back into the session
 * it came from puts each stem on the track its key names, as a CANDIDATE take
 * in that track's take group — never over what the track holds; a key whose
 * track is gone gets a new track. Into any other session, or a new one, the
 * arrangement is restored aligned with its tempo map, markers and accepted
 * emotional arc.
 *
 * VALIDATION IS THE GATE. Every file the manifest lists must be in the archive
 * with its hash and size, nothing may be in the archive that is not listed,
 * every stem must be a WAV at the package's sample rate and exactly the
 * package's length, and the format and version must be ones this engine
 * reads. An import validates first and writes nothing on any refusal.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { generateId } = require('../db/database');
const { saveFile, getFileUrl } = require('./file-storage');
const { resolveStored } = require('./data-paths');
const { MEDIA_KINDS } = require('./media-kinds');
const { findProjectMaster } = require('./conform');
const renderer = require('./music-renderer');
const { readZip } = require('./music-separation');
const { RIGHTS_STATUSES } = require('./music-stems');
const { VALIDATORS, toRow, readScoreSession } = require('./music-session');

const FORMAT = 'film-engine.score-package';
const VERSION = 1;
const SUPPORTED_VERSIONS = Object.freeze([1]);

/** The manifest, section by section: every one is written, and a package missing any is refused. */
const MANIFEST_SECTIONS = Object.freeze([
    'format', 'version', 'package', 'session', 'operations', 'picture', 'timing', 'markers',
    'tracks', 'stems', 'master', 'emotion', 'rights', 'provenance', 'files', 'matching',
]);

/** Inflation ceilings for reading a package: more and larger entries than a separation returns. */
const PACKAGE_ZIP_LIMITS = Object.freeze({ max_entries: 1024, max_inflated_bytes: 1024 * 1024 * 1024, max_total_bytes: 2 * 1024 * 1024 * 1024 });
/** A reference picture larger than this is described by hash rather than copied into the archive. */
const PICTURE_MAX_BYTES = 256 * 1024 * 1024;

/** Worst first: a stem is as encumbered as its most encumbered source. */
const RIGHTS_ORDER = ['blocked', 'expired', 'restricted', 'unknown', 'cleared'];

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const slug = s => String(s || 'stem').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'stem';
const key = (kind, id) => `fe:${kind}:${id}`;

// ── Canonical JSON and a deterministic ZIP ─────────────────────────────────

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = canonical(value[k]);
        return out;
    }
    return value;
}
const manifestBytes = m => Buffer.from(JSON.stringify(canonical(m), null, 2) + '\n', 'utf8');

/** Stored entries, sorted, with the DOS epoch as every timestamp: the same inputs give the same bytes. */
function writeZip(entries) {
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const DOS_TIME = 0, DOS_DATE = 0x21; // 1980-01-01 00:00:00
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of sorted) {
        const name = Buffer.from(e.name, 'utf8');
        const crc = zlib.crc32(e.bytes) >>> 0;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
        lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(e.bytes.length, 18); lh.writeUInt32LE(e.bytes.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
        const local = Buffer.concat([lh, name, e.bytes]);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
        ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(e.bytes.length, 20); ch.writeUInt32LE(e.bytes.length, 24); ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([ch, name]));
        locals.push(local);
        offset += local.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(sorted.length, 8); eocd.writeUInt16LE(sorted.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

// ── WAV and Broadcast WAV ──────────────────────────────────────────────────

/** A WAV's chunks and its facts, or null when it is not a RIFF/WAVE file. */
function wavInfo(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    const chunks = [];
    let p = 12, fmt = null, dataBytes = null;
    while (p + 8 <= buf.length) {
        const id = buf.toString('ascii', p, p + 4);
        const size = buf.readUInt32LE(p + 4);
        const body = buf.slice(p + 8, Math.min(buf.length, p + 8 + size));
        chunks.push({ id, body });
        if (id === 'fmt ' && body.length >= 16) fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), sample_rate: body.readUInt32LE(4), bit_depth: body.readUInt16LE(14) };
        if (id === 'data') dataBytes = size;
        p += 8 + size + (size % 2);
    }
    if (!fmt || dataBytes == null) return null;
    const frameBytes = fmt.channels * (fmt.bit_depth / 8);
    return { ...fmt, chunks, samples: frameBytes > 0 ? Math.floor(dataBytes / frameBytes) : 0 };
}

function fixed(str, len) { const b = Buffer.alloc(len); b.write(String(str || ''), 0, len, 'ascii'); return b; }

/** A bext chunk (EBU Tech 3285 v1, 602 bytes): the key in the description, time reference 0. */
function bextChunk(description, stamp) {
    const s = String(stamp || '').replace('T', ' ');
    const body = Buffer.concat([
        fixed(description, 256), fixed('Film Engine', 32), fixed('', 32),
        fixed(s.slice(0, 10) || '1980-01-01', 10), fixed(s.slice(11, 19) || '00:00:00', 8),
        Buffer.alloc(4), Buffer.alloc(4), // TimeReference low/high: sample 0 of the session
        (() => { const v = Buffer.alloc(2); v.writeUInt16LE(1, 0); return v; })(),
        Buffer.alloc(64), Buffer.alloc(190),
    ]);
    const head = Buffer.alloc(8); head.write('bext', 0, 'ascii'); head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
}

/** The same audio as a Broadcast WAV: fmt, then bext, then everything else but any old bext. */
function toBwf(buf, description, stamp) {
    const info = wavInfo(buf);
    if (!info) throw new Error('not a WAV file');
    const out = [];
    for (const c of info.chunks) {
        if (c.id === 'bext') continue;
        const head = Buffer.alloc(8); head.write(c.id, 0, 'ascii'); head.writeUInt32LE(c.body.length, 4);
        out.push(Buffer.concat([head, c.body, c.body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]));
        if (c.id === 'fmt ') out.push(bextChunk(description, stamp));
    }
    const payload = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...out]);
    const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(payload.length, 4);
    return Buffer.concat([riff, payload]);
}

// ── Building ───────────────────────────────────────────────────────────────

function metaOf(asset) { try { return JSON.parse(asset.metadata || '{}') || {}; } catch (_) { return {}; } }

function assetHash(asset) {
    const m = metaOf(asset);
    if (m.hash) return m.hash;
    try { return sha256(fs.readFileSync(resolveStored(asset.file_path))); } catch (_) { return null; }
}

function rightsFor(db, asset) {
    const r = db.prepare('SELECT * FROM film_rights WHERE entity_id = ? ORDER BY created_at LIMIT 1').get(asset.id);
    const status = RIGHTS_STATUSES.includes(r && r.status) ? r.status : (RIGHTS_STATUSES.includes(asset.license_status) ? asset.license_status : 'unknown');
    return {
        asset_id: asset.id, status, owner: (r && r.owner) || '', source: (r && r.source) || asset.license_source || '',
        license_url: (r && r.license_url) || '', territory: (r && r.territory) || '', expires_on: (r && r.expires_on) || '',
        restrictions: (r && r.restrictions) || '', recorded: !!r,
    };
}

/** The bounce whose fingerprint is the session as it stands, or a new one. */
async function currentBounce(db, sessionId) {
    const plan = renderer.planBounce(db, sessionId, { stems: 'instrument' });
    if (!plan.ok) return { error: plan };
    let found = renderer.listBounces(db, sessionId).find(b => b.status === 'complete' && b.fingerprint === plan.fingerprint && b.stems_mode === 'instrument');
    let rendered = false;
    if (!found) {
        const run = await renderer.runBounce(db, sessionId, { stems: 'instrument', force: true });
        if (!run.ok) return { error: { ok: false, status: run.status || 500, error: `the stems could not be rendered: ${run.error}` } };
        found = renderer.getBounce(db, sessionId, run.operation_id);
        rendered = true;
    }
    return { plan, bounce: found, rendered };
}

/**
 * Build the package for a session. Free: the only work is a local render when
 * the session has no current bounce. Returns the archive's asset, path and
 * hash, and `reused` when an identical package already existed.
 */
async function buildPackage(db, sessionId, opts) {
    const o = opts || {};
    const model = readScoreSession(db, sessionId);
    if (!model) return { ok: false, status: 404, error: 'Score session not found' };
    const s = model.session;
    const got = await currentBounce(db, sessionId);
    if (got.error) return got.error;
    const { plan, bounce } = got;
    const bounceRow = db.prepare('SELECT completed_at FROM film_music_operations WHERE id = ?').get(bounce.operation_id);
    const stamp = (bounceRow && bounceRow.completed_at) || '1980-01-01 00:00:00';

    const entries = [];
    const files = [];
    const add = (name, bytes) => { entries.push({ name, bytes }); files.push({ path: name, sha256: sha256(bytes), bytes: bytes.length }); return files[files.length - 1]; };

    // Stems, one per sounding track, as BWF; all the same length or nothing is built.
    const trackById = Object.fromEntries(model.tracks.map(t => [t.id, t]));
    const stems = [];
    let samples = null;
    const ordered = (bounce.stems || []).slice().sort((a, b) => {
        const ta = trackById[(a.track_ids || [])[0]], tb = trackById[(b.track_ids || [])[0]];
        return ((ta && ta.sort_order) || 0) - ((tb && tb.sort_order) || 0) || String(a.key).localeCompare(String(b.key));
    });
    for (const [n, st] of ordered.entries()) {
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(st.asset_id);
        const file = asset && resolveStored(asset.file_path);
        if (!file || !fs.existsSync(file)) return { ok: false, status: 409, error: `the rendered stem ${st.name} is missing from disk; bounce the session again` };
        const trackId = (st.track_ids || [])[0];
        const track = trackById[trackId] || { id: trackId, name: st.name };
        const k = key('track', track.id);
        const bytes = toBwf(fs.readFileSync(file), `${k} ${track.name || ''}`.trim(), stamp);
        const info = wavInfo(bytes);
        if (samples == null) samples = info.samples;
        else if (info.samples !== samples) return { ok: false, status: 500, error: `the rendered stems are not the same length (${st.name} has ${info.samples} samples against ${samples})` };
        const p = `stems/${String(n + 1).padStart(2, '0')}_${slug(track.name)}.wav`;
        const fl = add(p, bytes);
        const sources = (plan.clips || []).filter(c => c.track_id === track.id).map(c => c.asset_id);
        stems.push({ key: k, track_id: track.id, name: track.name || '', path: p, sha256: fl.sha256, bytes: fl.bytes, samples: info.samples,
            channels: info.channels, bit_depth: info.bit_depth, sample_rate: info.sample_rate, source_asset_ids: [...new Set(sources)] });
    }
    if (!stems.length) return { ok: false, status: 409, error: 'the session has nothing that sounds: every clip is muted, a guide, or not the selected take, so there are no stems to package' };

    // The master.
    const masterAsset = bounce.master && db.prepare('SELECT * FROM film_assets WHERE id = ?').get(bounce.master.asset_id);
    const masterFile = masterAsset && resolveStored(masterAsset.file_path);
    if (!masterFile || !fs.existsSync(masterFile)) return { ok: false, status: 409, error: 'the rendered master is missing from disk; bounce the session again' };
    const masterBytes = toBwf(fs.readFileSync(masterFile), `${key('session', s.id)} master`, stamp);
    const masterFl = add('master/score_master.wav', masterBytes);

    // The reference picture, when the film has one small enough to carry. A
    // session written against an EDIT carries that edit: it is the picture the
    // stems line up with, and the conformed assembly is a different film.
    const editPic = s.edit_id ? db.prepare(
        `SELECT a.* FROM film_edits e JOIN film_assets a ON a.id = e.asset_id WHERE e.id = ?`).get(s.edit_id) : null;
    const pic = editPic || findProjectMaster(db, s.project_id);
    let picture;
    const shots = (() => {
        try { const b = require('./music-context').compileScoreContext(db, { sessionId }); return ((b.brief && b.brief.picture && b.brief.picture.shots) || []).map(x => ({ code: x.shot_code, start_ms: x.start_ms, duration_ms: x.duration_ms })); }
        catch (_) { return []; }
    })();
    if (pic && fs.existsSync(resolveStored(pic.file_path))) {
        const picPath = resolveStored(pic.file_path);
        const size = fs.statSync(picPath).size;
        if (size <= PICTURE_MAX_BYTES && o.include_picture !== false) {
            const bytes = fs.readFileSync(picPath);
            const ext = (path.extname(pic.file_name || picPath) || '.mp4').toLowerCase();
            const fl = add(`picture/reference${ext}`, bytes);
            picture = { included: true, path: fl.path, sha256: fl.sha256, bytes: fl.bytes, asset_id: pic.id, version: pic.version, frame_rate: s.frame_rate, start_ms: 0, shots };
        } else {
            picture = { included: false, asset_id: pic.id, sha256: sha256(fs.readFileSync(picPath)), bytes: size, frame_rate: s.frame_rate, shots,
                reason: size > PICTURE_MAX_BYTES ? `the conformed film is ${size} bytes, over the ${PICTURE_MAX_BYTES}-byte ceiling for carrying it; it is identified by hash` : 'left out on request' };
        }
    } else {
        picture = { included: false, frame_rate: s.frame_rate, shots, reason: s.edit_id
            ? 'the edit this session is written against is missing from disk; the cut timings from the brief are listed instead'
            : 'no conformed film exists for this project yet; the shot timings from the brief are listed instead' };
    }

    // Placement, rights, provenance.
    const usedAssets = new Map();
    const tracks = model.tracks.map(t => ({
        id: t.id, key: key('track', t.id), name: t.name, role: t.role, role_kind: t.role_kind, sort_order: t.sort_order,
        gain_db: t.gain_db, pan: t.pan, muted: !!t.muted, soloed: !!t.soloed, output_track_id: t.output_track_id || null,
        stem: (stems.find(x => x.track_id === t.id) || {}).path || null,
        stem_reason: stems.some(x => x.track_id === t.id) ? null
            : ((plan.skipped || []).filter(x => x.track_id === t.id).map(x => x.reason).find(Boolean) || 'nothing on this track sounds in the mix'),
        clips: (t.clips || []).map(c => {
            const a = c.asset_id ? db.prepare('SELECT * FROM film_assets WHERE id = ?').get(c.asset_id) : null;
            if (a) usedAssets.set(a.id, a);
            return {
                id: c.id, key: key('clip', c.id), name: c.name, asset_id: c.asset_id, asset_sha256: a ? assetHash(a) : null,
                source_kind: c.source_kind, source_operation_id: c.source_operation_id || null,
                start_ms: c.start_ms, start_samples: Math.round(c.start_ms * 48), duration_ms: c.duration_ms, source_offset_ms: c.source_offset_ms,
                gain_db: c.gain_db, fade_in_ms: c.fade_in_ms, fade_out_ms: c.fade_out_ms, loop_policy: c.loop_policy, warp_policy: c.warp_policy,
                take_group: c.take_group, take_status: c.take_status,
            };
        }),
    }));
    const rights = [...usedAssets.values()].map(a => rightsFor(db, a)).sort((x, y) => x.asset_id.localeCompare(y.asset_id));
    for (const st of stems) {
        const statuses = st.source_asset_ids.map(id => (rights.find(r => r.asset_id === id) || { status: 'unknown' }).status);
        st.rights_status = RIGHTS_ORDER.find(r => statuses.includes(r)) || 'unknown';
        st.rights_owners = [...new Set(st.source_asset_ids.map(id => (rights.find(r => r.asset_id === id) || {}).owner).filter(Boolean))].sort();
    }
    const provenance = [...usedAssets.values()].map(a => {
        const m = metaOf(a);
        return { asset_id: a.id, kind: m.kind || a.asset_type, provider: a.provider || '', operation_id: m.operation_id || null,
            derived_from: m.derived_from || null, sha256: assetHash(a), file_name: a.file_name };
    }).sort((x, y) => x.asset_id.localeCompare(y.asset_id));

    const lengthMs = Math.round((samples / 48000) * 1000);
    const markers = (model.markers || []).map(k => ({ id: k.id, key: key('marker', k.id), kind: k.kind, position_ms: k.position_ms, position_samples: Math.round(k.position_ms * 48), label: k.label || '', shot_id: k.shot_id || null }))
        .sort((a, b) => a.position_ms - b.position_ms || a.id.localeCompare(b.id));
    const emotion = (model.emotion_ranges || []).filter(r => r.status === 'accepted')
        .map(r => ({ id: r.id, start_ms: r.start_ms, end_ms: r.end_ms, label: r.label, valence: r.valence, arousal: r.arousal, intensity: r.intensity, source: r.source, confidence: r.confidence }))
        .sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
    const sessionOps = [...new Set(tracks.flatMap(t => t.clips.map(c => c.source_operation_id)).filter(Boolean))].sort();

    const packageId = sha256(JSON.stringify(canonical({ session: s.id, fingerprint: bounce.fingerprint, picture: picture.sha256 || null, format: FORMAT, version: VERSION }))).slice(0, 24);
    const keys = {};
    keys[key('session', s.id)] = { kind: 'session', id: s.id };
    for (const t of tracks) { keys[t.key] = { kind: 'track', id: t.id }; for (const c of t.clips) keys[c.key] = { kind: 'clip', id: c.id }; }
    for (const k of markers) keys[k.key] = { kind: 'marker', id: k.id };

    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    const manifest = {
        format: FORMAT, version: VERSION,
        package: { id: packageId, name: `${s.name || 'score'} — v${bounce.version}`, built_from: 'score session', note: 'Stems are equal-length Broadcast WAV aligned at sample 0 of the session; place each at the start of the timeline.' },
        session: { id: s.id, key: key('session', s.id), name: s.name, project_id: s.project_id, status: s.status, sample_rate: s.sample_rate, frame_rate: s.frame_rate,
            sequence_id: s.sequence_id || null, scene_id: s.scene_id || null, edit_id: s.edit_id || null, fingerprints: { script: s.script_fingerprint || '', picture: s.picture_fingerprint || '', context: s.context_fingerprint || '' } },
        operations: { bounce_operation_id: bounce.operation_id, bounce_version: bounce.version, bounce_fingerprint: bounce.fingerprint, session_operation_ids: sessionOps },
        picture,
        timing: { sample_rate: 48000, bit_depth: 24, channels: 2, frame_rate: s.frame_rate, session_sample_rate: s.sample_rate, start_timecode: '00:00:00:00',
            length_ms: lengthMs, length_samples: samples, tempo_map: (s.tempo_map || []).map(t => ({ at_ms: t.at_ms, at_samples: Math.round(t.at_ms * 48), bpm: t.bpm, numerator: t.numerator, denominator: t.denominator })) },
        markers, tracks, stems,
        master: { path: masterFl.path, sha256: masterFl.sha256, bytes: masterFl.bytes, samples: wavInfo(masterBytes).samples },
        emotion, rights, provenance, files,
        matching: { scheme: 'film-engine/v1', session_key: key('session', s.id), keys,
            rule: 'A stem or track that comes back carrying one of these keys (in a BWF description, a file name, or a track name) belongs to the Film Engine row the key names; it lands beside that row as a new take and never replaces it.' },
    };
    entries.push({ name: 'manifest.json', bytes: manifestBytes(manifest) });
    const archive = writeZip(entries);
    const archiveSha = sha256(archive);

    // Reuse an identical package rather than registering it twice.
    const existing = db.prepare("SELECT * FROM film_assets WHERE project_id = ? AND asset_type = 'other' AND metadata LIKE ?").get(s.project_id, `%"sha256":"${archiveSha}"%`);
    const media = MEDIA_KINDS.music;
    if (existing && fs.existsSync(resolveStored(existing.file_path))) {
        return { ok: true, reused: true, package_id: packageId, asset_id: existing.id, file_path: resolveStored(existing.file_path), sha256: archiveSha, bytes: archive.length,
            url: getFileUrl(media.serveDir, s.project_id, existing.file_name), manifest, rendered: got.rendered };
    }
    const fileName = `score_package_${s.id.slice(0, 8)}_${packageId.slice(0, 12)}.zip`;
    const filePath = saveFile(s.project_id, media.subdir, fileName, archive);
    const assetId = generateId();
    const opId = generateId();
    const record = db.transaction(() => {
        db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, size_bytes, metadata, provider)
                    VALUES (?, ?, 'other', ?, ?, 'zip', 'application/zip', ?, ?, 'local')`)
            .run(assetId, s.project_id, filePath, fileName, archive.length, JSON.stringify({ kind: 'score_package', session_id: s.id, package_id: packageId, sha256: archiveSha,
                format: FORMAT, version: VERSION, bounce_operation_id: bounce.operation_id, operation_id: opId }));
        // A package is the DAW-neutral push: kind 'push', told apart from a DAW push by params.kind.
        const v = VALIDATORS.film_music_operations({ kind: 'push', status: 'complete', output_asset_id: assetId, provider: 'local',
            params: { kind: 'package', package_id: packageId, asset_id: assetId, sha256: archiveSha, bytes: archive.length, format: FORMAT, version: VERSION,
                bounce_operation_id: bounce.operation_id, fingerprint: bounce.fingerprint, stems: stems.length, picture_included: !!picture.included } });
        const r = toRow('film_music_operations', v.value);
        db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, output_asset_id, provider, params_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
            .run(opId, s.id, r.kind, r.status, r.output_asset_id, r.provider, r.params_json);
    });
    try { record(); } catch (e) { try { fs.unlinkSync(filePath); } catch (_) { /* gone */ } return { ok: false, status: 500, error: `the package could not be recorded: ${e.message}` }; }
    return { ok: true, reused: false, package_id: packageId, asset_id: assetId, operation_id: opId, file_path: filePath, sha256: archiveSha, bytes: archive.length,
        url: getFileUrl(media.serveDir, s.project_id, fileName), manifest, rendered: got.rendered };
}

function listPackages(db, sessionId) {
    return db.prepare("SELECT * FROM film_music_operations WHERE session_id = ? AND kind = 'push' ORDER BY created_at DESC, rowid DESC").all(sessionId)
        .map(r => { let p = {}; try { p = JSON.parse(r.params_json || '{}'); } catch (_) { p = {}; } return { r, p }; })
        .filter(x => x.p.kind === 'package')
        .map(({ r, p }) => {
            const a = p.asset_id ? db.prepare('SELECT project_id, file_name FROM film_assets WHERE id = ?').get(p.asset_id) : null;
            return { operation_id: r.id, package_id: p.package_id, asset_id: p.asset_id, sha256: p.sha256, bytes: p.bytes, stems: p.stems, picture_included: p.picture_included,
                bounce_operation_id: p.bounce_operation_id, created_at: r.created_at, url: a ? getFileUrl(MEDIA_KINDS.music.serveDir, a.project_id, a.file_name) : null, missing: !a };
        });
}

// ── Validating ─────────────────────────────────────────────────────────────

/** Read and check a package. Returns `{ ok, errors, warnings, manifest, entries }`; writes nothing. */
function validatePackage(buf) {
    const errors = [], warnings = [];
    const read = readZip(Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []), PACKAGE_ZIP_LIMITS);
    if (!read.ok) return { ok: false, errors: [`not a readable score package: ${read.error}`], warnings };
    const byName = new Map(read.entries.map(e => [e.name, e.bytes]));
    const raw = byName.get('manifest.json');
    if (!raw) return { ok: false, errors: ['the archive has no manifest.json at its root'], warnings };
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch (e) { return { ok: false, errors: [`manifest.json is not JSON: ${e.message}`], warnings }; }
    if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest.json is not an object'], warnings };

    for (const s of MANIFEST_SECTIONS) if (!(s in m)) errors.push(`the manifest has no ${s} section`);
    if ('format' in m && m.format !== FORMAT) errors.push(`format '${m.format}' is not a Film Engine score package (expected ${FORMAT})`);
    if ('version' in m && !SUPPORTED_VERSIONS.includes(m.version)) errors.push(`version ${m.version} is not one this engine reads (it reads ${SUPPORTED_VERSIONS.join(', ')})`);

    // Every listed file present with its hash and size; nothing unlisted.
    const listed = new Set();
    if (Array.isArray(m.files)) {
        for (const f of m.files) {
            listed.add(f.path);
            const bytes = byName.get(f.path);
            if (!bytes) { errors.push(`${f.path} is listed and missing from the archive`); continue; }
            if (sha256(bytes) !== f.sha256) errors.push(`${f.path}: its sha256 hash does not match the manifest — the file was changed after packaging`);
            if (bytes.length !== f.bytes) errors.push(`${f.path}: ${bytes.length} bytes, the manifest says ${f.bytes}`);
        }
        for (const name of byName.keys()) if (name !== 'manifest.json' && !listed.has(name)) errors.push(`${name} is in the archive and not listed in the manifest (unlisted)`);
    }

    // Stems: WAV, the package's rate, the package's length, each once.
    const t = m.timing || {};
    if (Array.isArray(m.stems)) {
        const seen = new Set();
        for (const st of m.stems) {
            if (seen.has(st.key)) errors.push(`two stems carry the key ${st.key}`);
            seen.add(st.key);
            if (!listed.has(st.path)) errors.push(`stem ${st.path} is not among the listed files`);
            const bytes = byName.get(st.path);
            if (!bytes) continue;
            const info = wavInfo(bytes);
            if (!info) { errors.push(`${st.path} is not a WAV file`); continue; }
            if (t.sample_rate && info.sample_rate !== t.sample_rate) errors.push(`${st.path}: ${info.sample_rate} Hz, not the package's sample rate of ${t.sample_rate} Hz`);
            if (t.length_samples && info.samples !== t.length_samples) errors.push(`${st.path}: ${info.samples} samples, not the package's length of ${t.length_samples} samples — stems must be equal length`);
            if (!info.chunks.some(c => c.id === 'bext')) warnings.push(`${st.path} carries no BWF bext chunk; it is placed at the session start`);
        }
        if (!m.stems.length) errors.push('the package holds no stems');
    }
    if (Array.isArray(m.tracks)) {
        const keys = m.tracks.map(x => x.key);
        if (new Set(keys).size !== keys.length) errors.push('two tracks carry the same matching key');
    }
    return { ok: errors.length === 0, errors, warnings, manifest: m, entries: byName };
}

// ── Importing ──────────────────────────────────────────────────────────────

/**
 * Import a package into a project: into `opts.session_id` (a round trip, stems
 * matched to their tracks by key and landed as candidate takes) or into a new
 * session restored from the manifest. Validates first; writes nothing on a
 * refusal.
 */
function importPackage(db, projectId, buf, opts) {
    const o = opts || {};
    const v = validatePackage(buf);
    if (!v.ok) return { ok: false, status: 400, error: `the package was refused: ${v.errors.join('; ')}`, errors: v.errors, warnings: v.warnings };
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return { ok: false, status: 404, error: 'Project not found' };
    const m = v.manifest;
    let target = null;
    if (o.session_id) {
        target = db.prepare('SELECT * FROM film_music_sessions WHERE id = ? AND project_id = ?').get(o.session_id, projectId);
        if (!target) return { ok: false, status: 404, error: 'Score session not found in this project' };
    }

    const media = MEDIA_KINDS.music;
    const written = [];
    const result = { matched: 0, created: 0, tracks: [] };
    let sessionId = target ? target.id : null;
    const opId = generateId();
    const run = db.transaction(() => {
        if (!sessionId) {
            const sv = VALIDATORS.film_music_sessions({ name: `${m.session.name || 'score'} (imported)`, frame_rate: m.timing.frame_rate || m.session.frame_rate,
                sample_rate: m.session.sample_rate, tempo_map: (m.timing.tempo_map || []).map(x => ({ at_ms: x.at_ms, bpm: x.bpm, numerator: x.numerator, denominator: x.denominator })),
                notes: `Imported from score package ${m.package.id}.` });
            if (!sv.ok) throw new Error(sv.errors.map(e => e.message).join('; '));
            const row = toRow('film_music_sessions', sv.value);
            sessionId = generateId();
            const cols = Object.keys(row);
            db.prepare(`INSERT INTO film_music_sessions (id, project_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`).run(sessionId, projectId, ...cols.map(k => row[k]));
            for (const k of m.markers || []) {
                const mv = VALIDATORS.film_music_markers({ kind: k.kind, position_ms: k.position_ms, label: k.label });
                if (!mv.ok) throw new Error(`marker ${k.label}: ${mv.errors.map(e => e.message).join('; ')}`);
                const r = toRow('film_music_markers', mv.value); const c = Object.keys(r);
                db.prepare(`INSERT INTO film_music_markers (id, session_id, ${c.join(', ')}) VALUES (?, ?, ${c.map(() => '?').join(', ')})`).run(generateId(), sessionId, ...c.map(x => r[x]));
            }
            for (const e of m.emotion || []) {
                const ev = VALIDATORS.film_music_emotion_ranges({ start_ms: e.start_ms, end_ms: e.end_ms, label: e.label, valence: e.valence, arousal: e.arousal, intensity: e.intensity,
                    source: 'imported', status: 'accepted', confidence: e.confidence == null ? 1 : e.confidence, rationale: `accepted in the session package ${m.package.id} came from` });
                if (!ev.ok) throw new Error(`emotion range ${e.label}: ${ev.errors.map(x => x.message).join('; ')}`);
                const r = toRow('film_music_emotion_ranges', ev.value); const c = Object.keys(r);
                db.prepare(`INSERT INTO film_music_emotion_ranges (id, session_id, ${c.join(', ')}) VALUES (?, ?, ${c.map(() => '?').join(', ')})`).run(generateId(), sessionId, ...c.map(x => r[x]));
            }
        }
        let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM film_music_tracks WHERE session_id = ?').get(sessionId).m + 1;
        for (const st of m.stems) {
            const bytes = v.entries.get(st.path);
            const info = wavInfo(bytes);
            const assetId = generateId();
            const fileName = `pkg_${slug(st.name)}_${assetId.slice(0, 8)}.wav`;
            const filePath = saveFile(projectId, media.subdir, fileName, bytes);
            written.push(filePath);
            const rightsStatus = RIGHTS_STATUSES.includes(st.rights_status) ? st.rights_status : 'unknown';
            db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, size_bytes, duration_ms, metadata, license_source, license_status, provider)
                        VALUES (?, ?, ?, ?, ?, 'wav', 'audio/wav', ?, ?, ?, 'external', ?, 'score-package')`)
                .run(assetId, projectId, media.assetType, filePath, fileName, bytes.length, m.timing.length_ms,
                    JSON.stringify({ kind: 'package_stem', matching_key: st.key, package_id: m.package.id, session_id: sessionId, hash: sha256(bytes), original_name: st.path,
                        derived_from_session: m.session.id, source_asset_ids: st.source_asset_ids || [], tech: { sample_rate: info.sample_rate, channels: info.channels, bit_depth: info.bit_depth, samples: info.samples } }),
                    rightsStatus);
            db.prepare(`INSERT INTO film_rights (id, project_id, entity_type, entity_id, subject, rights_type, status, owner, source, notes)
                        VALUES (?, ?, 'music', ?, ?, 'music_license', ?, ?, 'score package', ?)`)
                .run(generateId(), projectId, assetId, st.name || st.path, rightsStatus, (st.rights_owners || []).join(', '),
                    `from score package ${m.package.id}: the stem's rights are its most encumbered source's (${rightsStatus})`);
            // Rights (MUS-022): returned from a DAW or a package, the stem is its sources (where they exist here) and its manifest's claim.
            require('./music-rights').recordDerivative(db, assetId, st.source_asset_ids || [], `returned in score package ${m.package.id}`, { own_status: rightsStatus });

            const ref = m.matching && m.matching.keys && m.matching.keys[st.key];
            const home = ref && ref.kind === 'track' ? db.prepare('SELECT * FROM film_music_tracks WHERE id = ? AND session_id = ?').get(ref.id, sessionId) : null;
            let trackId, takeGroup = '', takeStatus = 'selected';
            if (home) {
                trackId = home.id; takeStatus = 'candidate';
                const held = db.prepare("SELECT take_group FROM film_music_clips WHERE track_id = ? AND take_group != '' LIMIT 1").get(trackId);
                takeGroup = held ? held.take_group : `takes:${trackId}`;
                db.prepare("UPDATE film_music_clips SET take_group = ? WHERE track_id = ? AND take_group = ''").run(takeGroup, trackId);
                result.matched++;
            } else {
                const src = (m.tracks || []).find(x => x.key === st.key) || {};
                const tv = VALIDATORS.film_music_tracks({ name: src.name || st.name || 'stem', role: src.role || '', role_kind: src.role_kind || 'instrument', sort_order: order++, gain_db: 0, pan: 0 });
                if (!tv.ok) throw new Error(`${st.path}: ${tv.errors.map(e => e.message).join('; ')}`);
                const r = toRow('film_music_tracks', tv.value); const c = Object.keys(r);
                trackId = generateId();
                db.prepare(`INSERT INTO film_music_tracks (id, session_id, ${c.join(', ')}) VALUES (?, ?, ${c.map(() => '?').join(', ')})`).run(trackId, sessionId, ...c.map(x => r[x]));
                result.created++;
            }
            const cv = VALIDATORS.film_music_clips({ name: st.name || 'stem', asset_id: assetId, source_operation_id: opId, source_kind: 'imported',
                start_ms: 0, duration_ms: m.timing.length_ms, source_offset_ms: 0, take_group: takeGroup, take_status: takeStatus });
            if (!cv.ok) throw new Error(`${st.path}: ${cv.errors.map(e => e.message).join('; ')}`);
            const cr = toRow('film_music_clips', cv.value); const cc = Object.keys(cr);
            const clipId = generateId();
            result.tracks.push({ key: st.key, track_id: trackId, clip_id: clipId, asset_id: assetId, matched: !!home, take_status: takeStatus });
            // The clip row is inserted after the operation exists (source_operation_id references it).
            result._clips = result._clips || [];
            result._clips.push({ clipId, trackId, cr, cc });
        }
        const ov = VALIDATORS.film_music_operations({ kind: 'import', status: 'complete', provider: 'score-package',
            params: { kind: 'package_import', package_id: m.package.id, from_session_id: m.session.id, format: m.format, version: m.version,
                matched: result.matched, created: result.created, stems: result.tracks.map(x => ({ key: x.key, track_id: x.track_id, matched: x.matched })), warnings: v.warnings } });
        const orow = toRow('film_music_operations', ov.value);
        db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, provider, params_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
            .run(opId, sessionId, orow.kind, orow.status, orow.provider, orow.params_json);
        for (const x of result._clips || []) {
            db.prepare(`INSERT INTO film_music_clips (id, track_id, ${x.cc.join(', ')}) VALUES (?, ?, ${x.cc.map(() => '?').join(', ')})`).run(x.clipId, x.trackId, ...x.cc.map(k => x.cr[k]));
        }
    });
    try { run(); } catch (e) {
        for (const f of written) { try { fs.unlinkSync(f); } catch (_) { /* gone */ } }
        return { ok: false, status: 400, error: `nothing was imported: ${e.message}` };
    }
    delete result._clips;
    return { ok: true, session_id: sessionId, operation_id: opId, package_id: m.package.id, ...result, warnings: v.warnings };
}

/** The bytes of a package handed over as an asset id or as data (a data URI or bare base64). */
function packageBytes(db, body) {
    const b = body || {};
    if (b.asset_id) {
        const a = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(b.asset_id);
        if (!a) return { error: { ok: false, status: 404, error: 'no asset with that id' } };
        const p = resolveStored(a.file_path);
        if (!p || !fs.existsSync(p)) return { error: { ok: false, status: 409, error: 'the package file is missing from disk' } };
        return { bytes: fs.readFileSync(p) };
    }
    if (typeof b.data === 'string' && b.data.length) {
        const s = b.data.replace(/^data:[^;,]*;base64,/, '');
        return { bytes: Buffer.from(s, 'base64') };
    }
    return { error: { ok: false, status: 400, error: 'send the package as asset_id, or as data (a data URI or base64)' } };
}

module.exports = {    FORMAT, VERSION, MANIFEST_SECTIONS,
    buildPackage, listPackages, validatePackage, importPackage, packageBytes, canonical,};
