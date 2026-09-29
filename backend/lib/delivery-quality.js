/**
 * THE PROJECT'S DELIVERY SETTINGS DRIVE QUALITY, AND THE ENGINE CHECKS IT.
 *
 * "We need to force this to generators and if they can't provide it, downgrade
 * to best quality — this is on us to check and put the safeguards to get the
 * appropriate resolution."
 *
 * Three parts, one module:
 *
 *   - What a generator will really DELIVER for the size it is asked. Every
 *     video adapter answers `deliverableFrame(payload)` from its own tables:
 *     the largest frame it offers at or below the ask, or its best when the
 *     ask is above everything it offers. `deliveryDecision` turns that into
 *     the `delivery` block every video payload carries, so a 4K project on a
 *     720p model says so before anything is bought.
 *   - What the MASTER is encoded as: the delivery preset's codec and audio
 *     layout, which applying a preset used to drop.
 *   - The DELIVERY CHECK: every shot's SELECTED clip, measured from the file,
 *     against the project's size. A clip below it is named with its fix (the
 *     upscale), because the only other way to find out is to open the file.
 */
const fs = require('fs');

/*
 * The master's encoder per delivery codec. Keys are the codec ids the
 * delivery presets use (lib/project-presets.js), so a preset always has a rule.
 * A codec this machine's ffmpeg cannot encode falls back to H.264 and says so
 * — a master in the wrong codec is recoverable, a master that is not written
 * is a delivery that fails at the very end.
 */
const CODECS = Object.freeze({
    h264: { encoder: 'libx264', args: ['-pix_fmt', 'yuv420p'], ext: 'mp4', audio: ['-c:a', 'aac'], label: 'H.264' },
    h265: { encoder: 'libx265', args: ['-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'], ext: 'mp4', audio: ['-c:a', 'aac'], label: 'H.265 / HEVC' },
    prores_422_proxy: { encoder: 'prores_ks', args: ['-profile:v', '0', '-pix_fmt', 'yuv422p10le'], ext: 'mov', audio: ['-c:a', 'pcm_s24le'], label: 'ProRes 422 Proxy' },
    prores_422_lt: { encoder: 'prores_ks', args: ['-profile:v', '1', '-pix_fmt', 'yuv422p10le'], ext: 'mov', audio: ['-c:a', 'pcm_s24le'], label: 'ProRes 422 LT' },
    prores_422: { encoder: 'prores_ks', args: ['-profile:v', '2', '-pix_fmt', 'yuv422p10le'], ext: 'mov', audio: ['-c:a', 'pcm_s24le'], label: 'ProRes 422' },
    prores_422_hq: { encoder: 'prores_ks', args: ['-profile:v', '3', '-pix_fmt', 'yuv422p10le'], ext: 'mov', audio: ['-c:a', 'pcm_s24le'], label: 'ProRes 422 HQ' },
    prores_4444: { encoder: 'prores_ks', args: ['-profile:v', '4', '-pix_fmt', 'yuva444p10le'], ext: 'mov', audio: ['-c:a', 'pcm_s24le'], label: 'ProRes 4444' },
    dnxhr_hq: { encoder: 'dnxhd', args: ['-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p'], ext: 'mov', audio: ['-c:a', 'pcm_s24le'], label: 'DNxHR HQ' },
    // A DCP is JPEG 2000 in an MXF wrapper with its own packaging; the master
    // carries the JPEG 2000 picture and a DCP tool packages it.
    jpeg2000: { encoder: 'jpeg2000', args: ['-pix_fmt', 'yuv444p'], ext: 'mov', audio: ['-c:a', 'pcm_s24le'], label: 'JPEG 2000 (package as a DCP)' },
});

/** An audio layout, as a preset or a person writes it, to a channel count. */
function channelCount(layout) {
    if (typeof layout === 'number' && Number.isFinite(layout) && layout >= 1) return Math.round(layout);
    const s = String(layout || '').trim().toLowerCase();
    if (!s || s === 'stereo' || s === '2.0' || s === '2') return 2;
    if (s === 'mono' || s === '1.0' || s === '1') return 1;
    const m = /^(\d+)\.(\d+)$/.exec(s);             // 5.1 → 6, 7.1 → 8, 12.0 → 12
    if (m) return Number(m[1]) + Number(m[2]);
    const n = Number(s);
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : 2;
}

let _encoders = null;
/** The encoders this machine's ffmpeg has, probed once. */
function availableEncoders() {
    if (_encoders) return _encoders;
    const set = new Set();
    try {
        const { resolveFfmpeg } = require('./ffmpeg');
        const ff = resolveFfmpeg();
        if (ff.available) {
            const out = require('child_process').execFileSync(ff.bin, ['-nostdin', '-hide_banner', '-encoders'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
            for (const line of out.split('\n')) {
                const m = /^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
                if (m) set.add(m[1]);
            }
        }
    } catch (_) { /* an unreadable list reads as "unknown", never as "nothing" */ }
    _encoders = set;
    return set;
}

/**
 * The encoder arguments for a delivery codec. `available: null` skips the
 * probe (tests, planning). Returns { video, audio, ext, codec, fallback }.
 */
function encoderFor(codec, opts) {
    const o = opts || {};
    const id = CODECS[codec] ? codec : 'h264';
    let rule = CODECS[id];
    let fallback = null;
    const have = o.available === null ? null : (o.available || availableEncoders());
    if (have && have.size && !have.has(rule.encoder)) {
        fallback = `${rule.label} (${rule.encoder}) is not in this machine's ffmpeg; the master is H.264 instead`;
        rule = CODECS.h264;
    }
    return { video: ['-c:v', rule.encoder, ...rule.args], audio: rule.audio.slice(), ext: rule.ext,
        codec: fallback ? 'h264' : id, label: rule.label, fallback };
}

const dims = s => {
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(String(s || ''));
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
};

/**
 * The `delivery` block a video payload carries: what the project asked for,
 * what the resolved generator will really deliver, and why when it is less.
 * Never throws — a decision that cannot be made is reported as unknown rather
 * than taking a paid generation down with it.
 */
function deliveryDecision(adapter, payload) {
    const p = payload || {};
    const asked = dims(p.target_resolution) || (p.width && p.height ? { width: p.width, height: p.height } : null);
    // The model only when it is this adapter's own: a tier can carry another
    // provider's model id, which this adapter substitutes and never runs.
    let own = [];
    try { own = (adapter && require('./providers').modelIdsFor(adapter, 'video')) || []; } catch (_) { own = []; }
    const out = { asked: asked ? `${asked.width}x${asked.height}` : null, delivered: null, downgraded: null, why: null,
        provider: adapter && adapter.id || null,
        model: (p.model && own.includes(p.model) ? p.model : null) || (adapter && adapter.defaultModel) || null };
    if (!adapter || typeof adapter.deliverableFrame !== 'function') {
        out.why = 'this provider does not say what size it delivers; the delivery check measures the clip when it arrives';
        return out;
    }
    try {
        const d = adapter.deliverableFrame(p);
        out.delivered = `${d.width}x${d.height}`;
        out.downgraded = !!d.downgraded;
        out.why = d.why || null;
        if (p.draft && p.draft.active) {
            out.draft = true;
            out.why = `drafting is on for this project, so the ${out.delivered} draft is asked on purpose. ${out.why || ''}`.trim();
        }
    } catch (err) {
        out.why = `could not work out the delivered size: ${err.message}`;
    }
    return out;
}

/**
 * Which clip plays for a shot: the SELECTED one, else the best-ranked kind,
 * newest first — the rule the timeline and the conform already use.
 */
const VIDEO_RANK = { video_final: 0, video_synced: 1, video_raw: 2 };

const _measured = new Map();
/** A clip's real size, cached on path + size + mtime (a file rewritten in place is re-measured). */
function measure(filePath) {
    let st;
    try { st = fs.statSync(filePath); } catch (_) { return { ok: false, reason: `there is no file at ${filePath}` }; }
    const key = `${filePath}|${st.size}|${st.mtimeMs}`;
    if (_measured.has(key)) return _measured.get(key);
    const r = require('./ffmpeg').inspectMedia(filePath);
    const out = r.ok && r.width && r.height ? { ok: true, width: r.width, height: r.height } : { ok: false, reason: r.reason || r.videoReason || 'no picture could be read' };
    if (_measured.size > 2000) _measured.clear();
    _measured.set(key, out);
    return out;
}

/**
 * Every shot's selected clip measured against the project's delivery size.
 * FREE: reads files, spends nothing. Status per shot: ok, below, no_clip,
 * unreadable. A clip is `below` when its long edge is under the project's.
 */
function deliveryCheck(db, projectId) {
    const project = db.prepare('SELECT id, title, target_resolution FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return null;
    const asked = dims(project.target_resolution) || { width: 1920, height: 1080 };
    const askedLong = Math.max(asked.width, asked.height);
    const shots = db.prepare(`SELECT s.id, s.shot_code, s.selected_video_asset_id, sc.scene_number
        FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id
        WHERE sc.project_id = ? AND sc.status != 'removed'
        ORDER BY ${require('./running-order').orderBySql({ shots: 's', scenes: 'sc' })}`).all(projectId);
    const rows = shots.map(sh => {
        const clip = require('./conform').selectedClip(db, sh.id);
        const base = { shot_id: sh.id, shot_code: sh.shot_code, scene_number: sh.scene_number };
        if (!clip) return { ...base, status: 'no_clip', asset_id: null, measured: null, fix: 'generate or upload a clip for this shot' };
        const m = measure(clip.file_path);
        if (!m.ok) return { ...base, status: 'unreadable', asset_id: clip.id, measured: null, reason: m.reason, fix: 'regenerate or re-upload this clip' };
        const below = Math.max(m.width, m.height) < askedLong;
        return { ...base, status: below ? 'below' : 'ok', asset_id: clip.id, asset_type: clip.asset_type,
            measured: `${m.width}x${m.height}`,
            fix: below ? `upscale this clip to ${asked.width}x${asked.height} (the Upscale action on its version, or post upscale)` : null };
    });
    const count = s => rows.filter(r => r.status === s).length;
    return { project_id: projectId, asked: `${asked.width}x${asked.height}`, shots: rows,
        summary: { ok: count('ok'), below: count('below'), no_clip: count('no_clip'), unreadable: count('unreadable') } };
}

/** The arguments that re-encode a finished master into the delivery codec and layout. */
function deliveryEncodeArgs(input, output, codec, channels, opts) {
    const e = encoderFor(codec, opts);
    const ch = channelCount(channels);
    return { args: ['-nostdin', '-y', '-i', input, ...e.video, ...e.audio, '-ac', String(ch), output], encoder: e, channels: ch };
}

/**
 * THE DELIVERY MASTER. The conform's master is the working file (H.264,
 * stereo) every other part of the engine plays and mixes into; a project whose
 * delivery says ProRes 422 HQ and 5.1 also gets that file, encoded from the
 * finished master, beside it. Nothing to do for an H.264 stereo delivery.
 * Never throws: a delivery encode that fails is reported, and the master stands.
 */
async function encodeDeliveryMaster(masterPath, project, opts) {
    const o = opts || {};
    const codec = String((project && project.delivery_codec) || '');
    const channels = channelCount(project && project.delivery_audio_channels);
    if ((!codec || codec === 'h264') && channels === 2) {
        return { ok: true, skipped: true, why: 'the delivery is H.264 stereo, which the master already is' };
    }
    const path = require('path');
    const { resolveFfmpeg } = require('./ffmpeg');
    const ff = resolveFfmpeg();
    if (!ff.available) return { ok: false, error: ff.reason || 'no encoder on this machine' };
    const e0 = encoderFor(codec);
    const out = path.join(path.dirname(masterPath), `${path.basename(masterPath, path.extname(masterPath))}_delivery.${e0.ext}`);
    const { args, encoder } = deliveryEncodeArgs(masterPath, out, codec, channels);
    try {
        await new Promise((resolve, reject) => {
            require('child_process').execFile(ff.bin, ['-nostdin', ...args.filter((a, i) => !(i === 0 && a === '-nostdin'))], { stdio: ['ignore', 'ignore', 'pipe'], timeout: o.timeoutMs || 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
                (err, _so, se) => err ? reject(new Error(String(se || err.message).split('\n').filter(Boolean).slice(-3).join(' '))) : resolve());
        });
    } catch (err) {
        return { ok: false, error: `the delivery encode failed: ${err.message}`, codec: encoder.codec };
    }
    const seen = require('./ffmpeg').inspectMedia(out);
    return { ok: true, path: out, codec: encoder.codec, label: encoder.label, channels, fallback: encoder.fallback,
        width: seen.ok ? seen.width : null, height: seen.ok ? seen.height : null,
        duration_ms: seen.ok ? Math.round(seen.durationSeconds * 1000) : null, measured_codec: seen.ok ? seen.codec : null };
}

module.exports = { CODECS, channelCount, encoderFor, availableEncoders, deliveryDecision, deliveryCheck,
    measure, deliveryEncodeArgs, encodeDeliveryMaster };
