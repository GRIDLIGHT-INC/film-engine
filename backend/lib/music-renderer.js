/**
 * THE DETERMINISTIC BOUNCE (MUS-008).
 *
 * The browser monitors a score session through an AudioContext; the film is
 * delivered from a FILE, rendered here from the same rows, and the two must
 * not disagree. So this module resolves the session's clips and automation
 * into ONE ffmpeg graph, writes a 48 kHz / 24-bit / stereo master plus the
 * chosen delivery stems, registers every output with the parameters that
 * made it, and refuses to render the same inputs twice unless told to.
 *
 * PLANNING IS PURE AND SEPARATE FROM RENDERING, the split `lib/conform.js`
 * already makes: `planBounce` reads the read model, decides what is audible
 * and why the rest is not, groups the stems, and fingerprints the whole
 * thing — it touches no file and spends nothing, so the page and the tools
 * can show what a bounce WOULD do. `buildBounceArgs` turns a plan into an
 * argument ARRAY (never a shell string: names come from the database), and
 * `runBounce` runs it, validates what came back, and records it.
 *
 * WHAT IS AUDIBLE IS ONE RULE, and it is the page's rule: track and clip
 * gain sum in dB along the routing chain, a mute anywhere on the chain
 * silences the clip, a solo anywhere in the session silences everything not
 * soloed, only the SELECTED take of a group plays, and reference and picture
 * tracks are guides that never reach the mix. Every clip left out is NAMED
 * with its reason — a bounce that quietly dropped a muted track and one that
 * quietly dropped a broken one look identical afterwards.
 *
 * NOTHING IS NORMALISED. `amix` scales its inputs by their count by default,
 * so two tones would come back 6 dB down and a lone clip's level would move
 * whenever a clip was added beside it. `normalize=0`, and the session length
 * is carried by a silent base input, so every output — master and every
 * stem — is exactly the session's length: the interchange baseline the epic
 * asks for (equal-length stems) is a property of the graph, not a check
 * afterwards.
 *
 * A BOUNCE IS A TAKE. Each render is a new operation with a new version and
 * new files; earlier masters stay registered and on disk, and the new one
 * names what it supersedes. The fingerprint covers everything the render
 * reads — placements, levels, fades, loops, automation, the files' own
 * identity — so an unchanged session is refused rather than rendered again,
 * and a changed one renders without anyone having to say what changed.
 *
 * WHAT IS NOT RENDERED IS SAID. Pan, send and filter automation have no
 * per-frame filter here; a curve on one of those parameters is reported as
 * not rendered and the track's static value is used. Gain and mute curves
 * ARE rendered, as per-frame expressions.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { generateId } = require('../db/database');
const { ensureDir, getFileUrl } = require('./file-storage');
const { resolveFfmpeg } = require('./ffmpeg');
const { parseProbe } = require('./audio-features');
const { resolveStored } = require('./data-paths');
const { MEDIA_KINDS } = require('./media-kinds');
const contracts = require('./music-session');

const { readScoreSession, VALIDATORS, toRow } = contracts;

/** How the delivery stems are grouped. `none` renders the master alone. */
const STEM_MODES = Object.freeze(['none', 'instrument', 'family', 'bus']);

/** The delivery format: the 48 kHz picture workflow, 24-bit, stereo. */
const OUTPUT = Object.freeze({ sample_rate: 48000, bit_depth: 24, channels: 2, codec: 'pcm_s24le', ext: 'wav', mime: 'audio/wav' });

/** Tracks that never reach the mix: guides for the person, not parts of the score. */
const GUIDE_ROLES = Object.freeze({ reference: 'reference track: a guide for the ear, never part of the mix', picture: 'picture track: the cut, never part of the mix' });

/** Automation the graph can draw per frame, and the parameters it cannot. */
const RENDERED_AUTOMATION = Object.freeze(['gain', 'mute']);

const dbToLinear = db => Math.pow(10, (Number(db) || 0) / 20);
const num = (v, d) => (v === undefined || v === null || Number.isNaN(Number(v))) ? d : Number(v);
const slug = s => String(s || 'stem').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'stem';

// ── The plan ───────────────────────────────────────────────────────────────

/** Walk a track's routing chain root-wards: the track, then what it feeds, until a bus or a cycle. */
function chainOf(track, byId) {
    const out = [];
    const seen = new Set();
    let t = track;
    while (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); t = t.output_track_id ? byId[t.output_track_id] : null; }
    return out;
}

/** Which stem a source track belongs to, per mode. */
function stemKeyFor(mode, track, byId) {
    if (mode === 'instrument') return track;
    const chain = chainOf(track, byId);
    if (mode === 'family') return chain.find(t => t.role_kind === 'family') || track;
    if (mode === 'bus') { const roots = chain.filter(t => t.role_kind === 'bus'); return roots.length ? roots[roots.length - 1] : track; }
    return null;
}

/** A file's identity for the fingerprint: its recorded hash when the importer wrote one, else size and mtime. */
function fileIdentity(asset, filePath) {
    try { const m = JSON.parse(asset.metadata || '{}'); if (m && m.hash) return 'sha256:' + m.hash; } catch (_) { /* not json */ }
    try { const st = fs.statSync(filePath); return `size:${st.size}:mtime:${Math.round(st.mtimeMs)}`; } catch (_) { return 'missing'; }
}

/**
 * Everything a bounce would do, and nothing done.
 *
 * `{ ok: false, error, status }` when it cannot be bounced as it stands —
 * a clip whose file is gone, nothing audible, an unknown stem mode — and
 * otherwise the plan: the audible clips with their resolved levels and
 * curves, the clips left out with reasons, the stems, the fingerprint, and
 * the version this render would become.
 */
function planBounce(db, sessionId, opts) {
    const o = opts || {};
    const mode = o.stems === undefined || o.stems === null || o.stems === '' ? 'none' : String(o.stems);
    if (!STEM_MODES.includes(mode)) return { ok: false, status: 400, error: `stems must be one of ${STEM_MODES.join(', ')}; '${mode}' is not a stem mode` };
    let model;
    try { model = readScoreSession(db, sessionId); } catch (e) { model = null; }
    if (!model || !model.session) return { ok: false, status: 404, error: 'Score session not found' };

    const warnings = [...(model.warnings || [])];
    const sourceRate = Number(model.session.sample_rate) || OUTPUT.sample_rate;
    if (sourceRate !== OUTPUT.sample_rate) warnings.push(`the session is ${sourceRate} Hz; the bounce is delivered at ${OUTPUT.sample_rate} Hz for the picture workflow and every source is resampled on render`);

    const byId = Object.fromEntries(model.tracks.map(t => [t.id, t]));
    const anySolo = model.tracks.some(t => t.soloed);
    const assetStmt = db.prepare('SELECT * FROM film_assets WHERE id = ?');
    const clips = [], skipped = [], refusals = [];
    const automationWarned = new Set();

    for (const track of model.tracks) {
        const chain = chainOf(track, byId);
        for (const clip of track.clips || []) {
            const skip = reason => skipped.push({ clip_id: clip.id, track_id: track.id, name: clip.name, reason });
            const guide = chain.map(t => GUIDE_ROLES[t.role_kind]).find(Boolean);
            if (guide) { skip(guide); continue; }
            if (clip.take_status !== 'selected') { skip(`take is ${clip.take_status}, not selected`); continue; }
            const muted = chain.find(t => t.muted);
            if (muted) { skip(muted.id === track.id ? 'track muted' : `routed through a muted track (${muted.name || muted.id})`); continue; }
            if (anySolo && !chain.some(t => t.soloed)) { skip('another track is soloed'); continue; }
            if (!clip.asset_id) { skip('no audio on this clip'); continue; }
            if (!(Number(clip.duration_ms) > 0)) { skip('zero length'); continue; }
            const asset = assetStmt.get(clip.asset_id);
            if (!asset) { refusals.push(`clip "${clip.name || clip.id}": its audio asset ${clip.asset_id} is not registered`); continue; }
            const filePath = resolveStored(asset.file_path);
            if (!filePath || !fs.existsSync(filePath)) { refusals.push(`clip "${clip.name || clip.id}": its file is not on disk (${asset.file_name || asset.file_path || 'no path'})`); continue; }

            const gainDb = chain.reduce((s, t) => s + (Number(t.gain_db) || 0), 0) + (Number(clip.gain_db) || 0);
            // Automation on the track (or its chain) that applies to this clip: the whole track, or this clip alone.
            const curves = [];
            for (const t of chain) {
                for (const a of t.automation || []) {
                    if (a.clip_id && a.clip_id !== clip.id) continue;
                    if (!RENDERED_AUTOMATION.includes(a.parameter)) {
                        const key = `${t.id}:${a.parameter}`;
                        if (!automationWarned.has(key)) {
                            automationWarned.add(key);
                            warnings.push(`${a.parameter} automation on track "${t.name || t.id}" is not rendered — the renderer draws gain and mute curves only, so the track's static ${a.parameter} is used`);
                        }
                        continue;
                    }
                    const points = (a.points || []).map(p => ({ at_ms: Math.round(Number(p.at_ms) || 0) - Number(clip.start_ms), value: Number(p.value) || 0 }))
                        .sort((x, y) => x.at_ms - y.at_ms);
                    if (points.length) curves.push({ parameter: a.parameter, interpolation: a.interpolation || 'linear', points });
                }
            }
            clips.push({
                clip_id: clip.id, track_id: track.id, name: clip.name || '', asset_id: asset.id, file: filePath,
                file_identity: fileIdentity(asset, filePath), asset_duration_ms: Number(asset.duration_ms) || 0,
                start_ms: Number(clip.start_ms) || 0, duration_ms: Number(clip.duration_ms), source_offset_ms: Number(clip.source_offset_ms) || 0,
                gain_db: gainDb, pan: Math.max(-1, Math.min(1, Number(track.pan) || 0)),
                fade_in_ms: Number(clip.fade_in_ms) || 0, fade_out_ms: Number(clip.fade_out_ms) || 0,
                loop_policy: clip.loop_policy || 'none', automation: curves,
            });
        }
    }
    if (refusals.length) return { ok: false, status: 409, error: `the session cannot be bounced as it stands: ${refusals.join('; ')}`, refusals, skipped, warnings };
    if (!clips.length) return { ok: false, status: 409, error: 'nothing to bounce: the session has no audible clips (' + (skipped.length ? skipped.map(s => `${s.name || s.clip_id}: ${s.reason}`).join('; ') : 'no clips') + ')', skipped, warnings };

    // Stems: one per group key, in track order, over the audible source tracks only.
    const stems = [];
    if (mode !== 'none') {
        const groups = new Map();
        for (const c of clips) {
            const key = stemKeyFor(mode, byId[c.track_id], byId);
            if (!groups.has(key.id)) groups.set(key.id, { key: key.id, name: key.name || key.id, role_kind: key.role_kind, track_ids: [], clip_ids: [] });
            const g = groups.get(key.id);
            if (!g.track_ids.includes(c.track_id)) g.track_ids.push(c.track_id);
            g.clip_ids.push(c.clip_id);
        }
        stems.push(...groups.values());
    }

    const duration_ms = Math.max(Number(model.duration_ms) || 0, ...clips.map(c => c.start_ms + c.duration_ms));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        output: OUTPUT, stems: mode, duration_ms, source_rate: sourceRate,
        clips: clips.map(c => ({ ...c, file: undefined, name: undefined })),
        groups: stems.map(s => ({ key: s.key, tracks: s.track_ids.slice().sort() })),
    })).digest('hex');

    const previous = lastComplete(db, sessionId);
    return {
        ok: true, session_id: sessionId, project_id: model.session.project_id,
        sample_rate: OUTPUT.sample_rate, source_sample_rate: sourceRate, bit_depth: OUTPUT.bit_depth, channels: OUTPUT.channels,
        duration_ms, stems_mode: mode, stems, clips, skipped, warnings, fingerprint,
        version: (previous ? previous.version : 0) + 1,
        previous: previous ? { operation_id: previous.operation_id, version: previous.version, fingerprint: previous.fingerprint } : null,
        unchanged: !!(previous && previous.fingerprint === fingerprint),
    };
}

// ── The graph ──────────────────────────────────────────────────────────────

const sec = ms => (Math.max(0, Number(ms) || 0) / 1000).toFixed(6);

/** A piecewise expression in clip-local seconds, from sorted points; hold interpolation steps, anything else ramps. */
function curveExpr(points, hold) {
    const pts = points.map(p => ({ t: Math.max(0, p.at_ms) / 1000, v: p.value }));
    if (!pts.length) return '0';
    let expr = String(pts[pts.length - 1].v);
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        if (i === 0) { expr = `if(lt(t,${p.t.toFixed(6)}),${p.v},${expr})`; continue; }
        const q = pts[i - 1];
        const span = Math.max(1e-6, p.t - q.t);
        const seg = hold ? String(q.v) : `(${q.v}+(${p.v}-${q.v})*(t-${q.t.toFixed(6)})/${span.toFixed(6)})`;
        expr = `if(lt(t,${p.t.toFixed(6)}),${seg},${expr})`;
    }
    return expr;
}

/** The volume filter for one clip: a constant, or a per-frame expression when a curve applies. */
function volumeFilter(c) {
    const gains = c.automation.filter(a => a.parameter === 'gain');
    const mutes = c.automation.filter(a => a.parameter === 'mute');
    if (!gains.length && !mutes.length) return `volume=${dbToLinear(c.gain_db).toFixed(6)}`;
    const db = [String(c.gain_db), ...gains.map(a => curveExpr(a.points, a.interpolation === 'hold'))].join('+');
    const mute = mutes.map(a => `(1-clip(${curveExpr(a.points, true)},0,1))`).join('*');
    const expr = `pow(10,(${db})/20)${mute ? '*' + mute : ''}`;
    return `volume='${expr}':eval=frame`;
}

/**
 * The encoder invocation for a plan: input files, a silent base per output
 * so every file is the session's exact length, one chain per clip, one mix
 * per output. Returns { args, outputs } where outputs name the files in
 * `-map` order — the master first, then the stems in plan order.
 */
function buildBounceArgs(plan, dir, baseName) {
    const files = [...new Set(plan.clips.map(c => c.file))];
    const inputIndex = Object.fromEntries(files.map((f, i) => [f, i]));
    const outputs = [{ kind: 'bounce_master', key: 'master', name: `${baseName}_master.${OUTPUT.ext}`, stem: null }];
    for (const s of plan.stems) outputs.push({ kind: 'bounce_stem', key: s.key, name: `${baseName}_stem_${slug(s.name)}.${OUTPUT.ext}`, stem: s });
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin'];
    for (const f of files) args.push('-i', f);
    // One silent base per output: an input can be consumed once, and the base
    // is what makes every output exactly the session's length.
    for (let i = 0; i < outputs.length; i++) args.push('-f', 'lavfi', '-i', `anullsrc=r=${OUTPUT.sample_rate}:cl=stereo`);
    const total = sec(plan.duration_ms);
    const filters = [];
    const fmt = `aresample=${OUTPUT.sample_rate},aformat=sample_fmts=fltp:channel_layouts=stereo`;

    plan.clips.forEach((c, i) => {
        const off = c.source_offset_ms, dur = c.duration_ms;
        const avail = c.asset_duration_ms > 0 ? Math.max(0, c.asset_duration_ms - off) : null;
        const loops = (c.loop_policy === 'loop' || c.loop_policy === 'fill') && avail !== null && avail > 0 && avail < dur;
        const chain = [];
        chain.push(loops ? `atrim=start=${sec(off)}:end=${sec(off + avail)}` : `atrim=start=${sec(off)}:end=${sec(off + dur)}`);
        chain.push('asetpts=PTS-STARTPTS', fmt);
        if (loops) chain.push(`aloop=loop=-1:size=${Math.max(1, Math.round(avail / 1000 * OUTPUT.sample_rate))}`, `atrim=duration=${sec(dur)}`);
        chain.push(volumeFilter(c));
        if (c.fade_in_ms > 0) chain.push(`afade=t=in:st=0:d=${sec(c.fade_in_ms)}`);
        if (c.fade_out_ms > 0) chain.push(`afade=t=out:st=${sec(Math.max(0, dur - c.fade_out_ms))}:d=${sec(c.fade_out_ms)}`);
        const L = c.pan <= 0 ? 1 : 1 - c.pan, R = c.pan >= 0 ? 1 : 1 + c.pan;
        if (c.pan !== 0) chain.push(`pan=stereo|c0=${L.toFixed(4)}*c0|c1=${R.toFixed(4)}*c1`);
        if (c.start_ms > 0) chain.push(`adelay=${Math.round(c.start_ms)}|${Math.round(c.start_ms)}`);
        // The master hears every clip; a stem hears its own. One split per use.
        const uses = 1 + (plan.stems.some(s => s.clip_ids.includes(c.clip_id)) ? 1 : 0);
        const labels = uses === 2 ? `[c${i}m][c${i}s]` : `[c${i}m]`;
        chain.push(uses === 2 ? `asplit=2${labels}` : `anull${labels}`);
        filters.push(`[${inputIndex[c.file]}:a]` + chain.join(','));
    });

    outputs.forEach((out, oi) => {
        const baseIdx = files.length + oi;
        const members = out.stem ? plan.clips.map((c, i) => out.stem.clip_ids.includes(c.clip_id) ? `[c${i}s]` : null).filter(Boolean)
            : plan.clips.map((c, i) => `[c${i}m]`);
        filters.push(`[${baseIdx}:a]atrim=duration=${total},asetpts=PTS-STARTPTS[base${oi}]`);
        filters.push(`[base${oi}]${members.join('')}amix=inputs=${members.length + 1}:normalize=0:duration=first[out${oi}]`);
    });
    args.push('-filter_complex', filters.join(';'));
    outputs.forEach((out, oi) => {
        args.push('-map', `[out${oi}]`, '-c:a', OUTPUT.codec, '-ar', String(OUTPUT.sample_rate), '-ac', String(OUTPUT.channels), path.join(dir, out.name));
    });
    return { args, outputs };
}

// ── Running it ─────────────────────────────────────────────────────────────

function runEncoder(bin, args) {
    return new Promise(resolve => {
        execFile(bin, args, { timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({
            code: err ? (err.code === undefined ? 1 : err.code) : 0,
            stderr: String(stderr || (err && err.message) || ''),
        }));
    });
}

function probeFile(bin, file) {
    const { spawnSync } = require('child_process');
    const r = spawnSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 60000 });
    return parseProbe(String(r.stderr || ''));
}

/** The last complete bounce of a session, with its version and fingerprint. */
function lastComplete(db, sessionId) {
    const rows = db.prepare("SELECT id, params_json, created_at FROM film_music_operations WHERE session_id = ? AND kind = 'bounce' AND status = 'complete' ORDER BY created_at DESC, id DESC").all(sessionId);
    let best = null;
    for (const r of rows) {
        let p = {}; try { p = JSON.parse(r.params_json || '{}'); } catch (_) { p = {}; }
        const v = Number(p.version) || 0;
        if (!best || v > best.version) best = { operation_id: r.id, version: v, fingerprint: p.fingerprint || null };
    }
    return best;
}

function dropFiles(paths) { for (const p of paths) { try { fs.unlinkSync(p); } catch (_) { /* already gone */ } } }

/**
 * Render a session: plan, refuse an unchanged rerender unless forced, run
 * the encoder, validate every output, register the assets and the
 * operation. A failure leaves a FAILED operation naming why, no assets and
 * no files.
 */
async function runBounce(db, sessionId, opts) {
    const o = opts || {};
    const plan = planBounce(db, sessionId, o);
    if (!plan.ok) return plan;
    if (plan.unchanged && !o.force) {
        return { ok: false, status: 409, code: 'UNCHANGED', previous_operation_id: plan.previous.operation_id,
            error: `the session is unchanged since bounce v${plan.previous.version} (operation ${plan.previous.operation_id}) — it is already rendered; pass force to render it again as a new version`, plan };
    }
    let bin = o.bin;
    if (!bin) {
        const enc = resolveFfmpeg();
        if (!enc || !enc.available) return { ok: false, status: 503, error: `no encoder available to bounce: ${(enc && enc.reason) || 'ffmpeg not found'} — install ffmpeg or set FFMPEG_PATH`, plan };
        bin = enc.bin;
    }

    const kind = MEDIA_KINDS.music;
    const dir = ensureDir(plan.project_id, kind.subdir);
    const operationId = generateId();
    const baseName = `score_${sessionId.slice(0, 8)}_v${plan.version}_${operationId.slice(0, 6)}`;
    const { args, outputs } = buildBounceArgs(plan, dir, baseName);
    const supersedes = plan.previous ? plan.previous.operation_id : null;
    const paramsBase = { stems_mode: plan.stems_mode, fingerprint: plan.fingerprint, version: plan.version, supersedes, forced: !!o.force,
        output: OUTPUT, duration_ms: plan.duration_ms, ffmpeg_args: args, skipped: plan.skipped, warnings: plan.warnings,
        clips: plan.clips.map(c => ({ ...c, file: undefined })) };

    const opv = VALIDATORS.film_music_operations({ kind: 'bounce', status: 'running', parent_id: supersedes, params: paramsBase });
    if (!opv.ok) return { ok: false, status: 500, error: opv.errors.map(e => e.message).join('; ') };
    const opRow = toRow('film_music_operations', opv.value);
    db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, parent_id, params_json, started_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(operationId, sessionId, opRow.kind, opRow.status, opRow.parent_id, opRow.params_json);
    const written = outputs.map(x => path.join(dir, x.name));
    const fail = (message) => {
        dropFiles(written);
        db.prepare(`UPDATE film_music_operations SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`).run(message.slice(0, 2000), operationId);
        return { ok: false, status: 500, error: message, operation_id: operationId, plan };
    };

    const run = await runEncoder(bin, args);
    if (run.code !== 0) {
        const tail = run.stderr.trim().split('\n').slice(-4).join(' | ');
        return fail(`the encoder failed (${bin}: ${run.code}): ${tail || 'no output'}`);
    }
    // Validate what came back before anything is registered: the format, and the length the graph promised.
    const facts = [];
    for (const out of outputs) {
        const file = path.join(dir, out.name);
        if (!fs.existsSync(file)) return fail(`the encoder exited 0 and wrote no ${out.key} file`);
        const p = probeFile(bin, file);
        const problems = [];
        if (p.sample_rate !== OUTPUT.sample_rate) problems.push(`${p.sample_rate} Hz, not ${OUTPUT.sample_rate}`);
        if (p.channels !== OUTPUT.channels) problems.push(`${p.channels} channel(s), not ${OUTPUT.channels}`);
        if (!(p.duration_ms > 0) || Math.abs(p.duration_ms - plan.duration_ms) > 60) problems.push(`${p.duration_ms} ms long against a ${plan.duration_ms} ms session`);
        if (problems.length) return fail(`the render did not validate (${out.name}): ${problems.join('; ')}`);
        facts.push({ out, file, probe: p, size: fs.statSync(file).size });
    }

    const registered = [];
    const write = db.transaction(() => {
        const insert = db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, size_bytes, duration_ms, metadata, provider, license_source, license_status)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local-ffmpeg', 'rendered', ?)`);
        for (const f of facts) {
            const id = generateId();
            const meta = {
                kind: f.out.kind, session_id: sessionId, operation_id: operationId, bounce_version: plan.version, supersedes,
                fingerprint: plan.fingerprint, stems_mode: plan.stems_mode, sample_rate: OUTPUT.sample_rate, bit_depth: OUTPUT.bit_depth, channels: OUTPUT.channels,
                codec: OUTPUT.codec, duration_ms: f.probe.duration_ms,
                stem: f.out.stem ? { key: f.out.stem.key, name: f.out.stem.name, role_kind: f.out.stem.role_kind, track_ids: f.out.stem.track_ids } : null,
                sources: [...new Set((f.out.stem ? plan.clips.filter(c => f.out.stem.clip_ids.includes(c.clip_id)) : plan.clips).map(c => c.asset_id))],
            };
            insert.run(id, plan.project_id, f.out.kind === 'bounce_master' ? 'audio_mix' : kind.assetType, f.file, f.out.name, OUTPUT.ext, OUTPUT.mime, f.size, f.probe.duration_ms, JSON.stringify(meta), 'unknown');
            registered.push({ asset_id: id, kind: f.out.kind, key: f.out.key, name: f.out.name, url: getFileUrl(kind.serveDir, plan.project_id, f.out.name), duration_ms: f.probe.duration_ms, size_bytes: f.size,
                track_ids: f.out.stem ? f.out.stem.track_ids : null });
        }
        const master = registered.find(r => r.kind === 'bounce_master');
        db.prepare(`UPDATE film_music_operations SET status = 'complete', output_asset_id = ?, params_json = ?, completed_at = datetime('now') WHERE id = ?`)
            .run(master.asset_id, JSON.stringify({ ...paramsBase, outputs: registered.map(r => ({ asset_id: r.asset_id, kind: r.kind, key: r.key, name: r.name })) }), operationId);
    });
    try { write(); } catch (e) { return fail(`the render could not be recorded: ${e.message}`); }

    const master = registered.find(r => r.kind === 'bounce_master');
    return {
        ok: true, operation_id: operationId, version: plan.version, supersedes, fingerprint: plan.fingerprint,
        master, stems: registered.filter(r => r.kind === 'bounce_stem'), plan, warnings: plan.warnings,
    };
}

/** Every bounce of a session, newest version first, with its outputs; the newest complete one is `current`. */
function listBounces(db, sessionId) {
    const rows = db.prepare("SELECT * FROM film_music_operations WHERE session_id = ? AND kind = 'bounce' ORDER BY created_at DESC, id DESC").all(sessionId);
    const asset = db.prepare('SELECT id, file_name, project_id, duration_ms, size_bytes, metadata FROM film_assets WHERE id = ?');
    const list = rows.map(r => {
        let p = {}; try { p = JSON.parse(r.params_json || '{}'); } catch (_) { p = {}; }
        const outputs = (p.outputs || []).map(o => {
            const a = asset.get(o.asset_id);
            return a ? { ...o, url: getFileUrl(MEDIA_KINDS.music.serveDir, a.project_id, a.file_name), duration_ms: a.duration_ms, size_bytes: a.size_bytes,
                track_ids: (() => { try { const m = JSON.parse(a.metadata || '{}'); return m.stem ? m.stem.track_ids : null; } catch (_) { return null; } })() } : { ...o, url: null, missing: true };
        });
        return {
            operation_id: r.id, version: Number(p.version) || 0, status: r.status, fingerprint: p.fingerprint || null, stems_mode: p.stems_mode || 'none',
            supersedes: p.supersedes || null, forced: !!p.forced, created_at: r.created_at, completed_at: r.completed_at, error_message: r.error_message || '',
            master: outputs.find(o => o.kind === 'bounce_master') || null, stems: outputs.filter(o => o.kind === 'bounce_stem'),
            skipped: p.skipped || [], warnings: p.warnings || [], current: false,
        };
    }).sort((a, b) => b.version - a.version || String(b.created_at).localeCompare(String(a.created_at)));
    const current = list.find(b => b.status === 'complete');
    if (current) current.current = true;
    return list;
}

function getBounce(db, sessionId, operationId) {
    return listBounces(db, sessionId).find(b => b.operation_id === operationId) || null;
}

module.exports = { STEM_MODES, OUTPUT, GUIDE_ROLES, RENDERED_AUTOMATION, planBounce, buildBounceArgs, runBounce, listBounces, getBounce, curveExpr, lastComplete };
