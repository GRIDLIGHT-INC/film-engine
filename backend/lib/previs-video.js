/**
 * A shot's previz move, rendered through its set to an MP4. Free and local.
 *
 * "The camera follows a girl running from the top floor down through five
 * levels of the house": a one-take is judged by watching it, and the Look
 * view plays it only while the page is open. This renders the same move —
 * the camera path the playhead shows (cameraPoseAt mirrors worldPoseAtT), the
 * staged people along their paths (subjectPoseAt, the sampler the Plan view
 * draws with) — through the shot's pinned world GLB in Blender (Workbench,
 * headless, nothing billed), and ffmpeg encodes the frames.
 *
 * Planning is pure and separate from rendering, the conform's split: `plan`
 * reads the rows and says exactly which frames would be rendered, and refuses
 * (by name) a shot with no set to stand in. `render` runs Blender, then
 * ffmpeg, and registers the file as a film_assets row (asset_type 'other',
 * metadata.kind 'previs_video') in the project's 03 Previs folder. Every
 * export is a new version; earlier ones stay.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { subjectPoseAt, cameraPoseAt, aimPoint } = require('./previs-subject-path');

function db() { return require('../db/database').db; }

const SCRIPT = path.join(__dirname, '..', 'blender-previz.py');
const MAX_FRAMES = 3600;
const DEFAULT_WIDTH = 1280;
const KIND = 'previs_video';

/** In-flight renders, by shot: what the page and an agent poll. */
const JOBS = new Map();

function refuse(message, status, code) {
    const e = new Error(message);
    e.status = status; e.code = code;
    return e;
}

/** Three.js / glTF axes (y up, -z north) to Blender's (z up, +y north). */
function toBlender(p) { return [p[0], -p[2], p[1]]; }

function aspectOf(raw) {
    const m = String(raw || '16:9').match(/^([\d.]+)\s*:\s*([\d.]+)$/);
    const r = m ? parseFloat(m[1]) / parseFloat(m[2]) : 16 / 9;
    return Number.isFinite(r) && r > 0 ? r : 16 / 9;
}

const DEFAULT_SIZE = { human: [0.5, 1.7, 0.3], cube: [1, 1, 1], sphere: [1, 1, 1], mesh: [1, 1.8, 1], imageplane: [1, 1.7, 0.02] };

/** The GLB a staged subject is drawn from, or null for a plain box. */
function subjectGlb(su, projectId) {
    const m = su.model || (su.kind === 'human' ? { library: 'man' } : null);
    if (!m) return null;
    if (m.library) {
        const e = require('./previs-library').get(m.library);
        return e && e.file && fs.existsSync(e.file) ? e.file : null;
    }
    if (m.asset_id) {
        const row = db().prepare('SELECT file_path FROM film_assets WHERE id = ? AND project_id = ?').get(m.asset_id, projectId);
        return row && row.file_path && fs.existsSync(row.file_path) ? row.file_path : null;
    }
    return null;
}

/**
 * What would be rendered: the frames, each camera pose and subject pose, the
 * world and the size. Free; writes nothing. Throws a refusal with a status.
 */
function plan(shotId, opts = {}) {
    const shot = db().prepare(`SELECT s.id, s.shot_code, sc.project_id, p.target_fps, p.aspect_ratio
        FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id JOIN film_projects p ON p.id = sc.project_id
        WHERE s.id = ?`).get(shotId);
    if (!shot) throw refuse('Shot not found', 404, 'NOT_FOUND');
    const row = db().prepare('SELECT world_version_id FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    const blocking = require('../routes/previs').loadBlocking(shotId);
    if (!blocking || !row) throw refuse('This shot has no previs yet: stage it in Previs first.', 409, 'NO_BLOCKING');
    if (!row.world_version_id) {
        throw refuse('This shot is not in a set: build or pin a world to it in Previs, then export the move.', 409, 'NO_WORLD');
    }
    const v = db().prepare('SELECT scale_factor FROM film_world_versions WHERE id = ?').get(row.world_version_id);
    const glb = db().prepare(`SELECT a.file_path FROM film_world_assets w JOIN film_assets a ON a.id = w.asset_id
        WHERE w.world_version_id = ? AND w.kind = 'collider'`).get(row.world_version_id);
    if (!glb || !glb.file_path || !fs.existsSync(glb.file_path)) {
        throw refuse('The world this shot is pinned to has no 3D model stored on this machine, so there is nothing to render through.', 409, 'NO_COLLIDER');
    }
    const f = Number(v && v.scale_factor) > 0 ? Number(v.scale_factor) : 1;

    const fps = Math.max(1, Math.min(60, Number(opts.fps) || Number(shot.target_fps) || 24));
    const durationMs = Math.max(1, Number(blocking.durationMs) || 4000);
    let frames = Math.max(1, Math.round(durationMs / 1000 * fps));
    const warnings = [];
    if (frames > MAX_FRAMES) {
        warnings.push(`${frames} frames is more than ${MAX_FRAMES}; rendered at ${Math.floor(MAX_FRAMES / (durationMs / 1000))} fps instead`);
        frames = MAX_FRAMES;
    }
    const even = n => Math.max(2, Math.round(n / 2) * 2);
    const width = even(Math.max(160, Math.min(1920, Number(opts.width) || DEFAULT_WIDTH)));
    const height = even(width / aspectOf(shot.aspect_ratio));

    const camera = blocking.camera || {};
    let sensorWidth = 36;
    try { sensorWidth = require('./previs-camera').sensorFor(camera.sensorId || 'super35').widthMm; } catch (_) { sensorWidth = 24.89; }

    const staged = (blocking.subjects || []).filter(s => s && Array.isArray(s.position));
    const subjects = staged.map(su => {
        const [w, h, d] = Array.isArray(su.sizeM) ? su.sizeM : (DEFAULT_SIZE[su.kind] || [1, 1, 1]);
        return { name: su.name || null, glb: subjectGlb(su, shot.project_id), size: [w / f, d / f, h / f], fit: !!su.fitToModel };
    });

    const out = [];
    for (let i = 0; i < frames; i++) {
        const t = frames > 1 ? i / (frames - 1) : 0;
        const pose = cameraPoseAt(blocking.path, t)
            || { position: camera.position || [0, 1.6, 0], rotation: camera.rotation || [0, 0, 0], focalMm: camera.focalMm || 35 };
        out.push({
            t,
            cam: {
                eye: toBlender(pose.position), target: toBlender(aimPoint(pose)),
                roll: (pose.rotation && pose.rotation[2]) || 0, lens_mm: Number(pose.focalMm) || Number(camera.focalMm) || 35,
            },
            subjects: staged.map(su => {
                const p = subjectPoseAt(su, t * durationMs);
                return [...toBlender(p.position), p.yawDeg];
            }),
        });
    }
    return {
        shot_id: shotId, shot_code: shot.shot_code, project_id: shot.project_id,
        world_version_id: row.world_version_id, world_glb: glb.file_path,
        fps, duration_ms: durationMs, frame_count: frames, width, height,
        sensor_width_mm: sensorWidth, subjects, frames: out, warnings,
        cost: 'Free: Blender and ffmpeg on this machine.',
    };
}

function encode(framesDir, fps, outPath) {
    const { resolveFfmpeg } = require('./ffmpeg');
    const ff = resolveFfmpeg();
    if (!ff.available) return Promise.reject(refuse(ff.reason || 'ffmpeg is not available', 503, 'NO_FFMPEG'));
    return new Promise((resolve, reject) => {
        const child = spawn(ff.bin, ['-nostdin', '-loglevel', 'error', '-y', '-framerate', String(fps),
            '-i', path.join(framesDir, 'frame_%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', b => { err += b; });
        child.on('close', code => (code === 0 && fs.existsSync(outPath) ? resolve(outPath)
            : reject(refuse(`ffmpeg could not encode the previz (exit ${code}): ${err.slice(-400)}`, 500, 'ENCODE_FAILED'))));
    });
}

function urlFor(projectId, fileName) { return `/film/previs/media/${projectId}/${encodeURIComponent(fileName)}`; }

function rowOut(r) {
    let m = {}; try { m = JSON.parse(r.metadata || '{}'); } catch (_) { m = {}; }
    return { asset_id: r.id, file_name: r.file_name, url: urlFor(r.project_id, r.file_name), version: r.version,
             created_at: r.created_at, duration_ms: r.duration_ms, ...m };
}

/** Every previz video exported for a shot, newest first, and any render in flight. */
function list(shotId) {
    const rows = db().prepare(`SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'other'
        AND json_valid(metadata) AND json_extract(metadata, '$.kind') = ? ORDER BY version DESC, created_at DESC`).all(shotId, KIND);
    return { shot_id: shotId, videos: rows.map(rowOut), job: JOBS.get(shotId) || null };
}

/**
 * Render now. Resolves with the registered video; the JOBS entry says how far
 * it got while it runs. A refusal (no Blender, no set, one already running) is
 * thrown before anything is written.
 */
function render(shotId, opts = {}) {
    // Every refusal is thrown HERE, synchronously, so a caller that starts the
    // render without waiting still answers the refusal rather than "started".
    const running = JOBS.get(shotId);
    if (running && (running.status === 'running' || running.status === 'encoding')) {
        throw refuse('A previz video for this shot is already rendering.', 409, 'RUNNING');
    }
    const p = plan(shotId, opts);
    const setBuild = require('./set-build');
    const blender = setBuild.resolveBlender();
    if (!blender.available) throw refuse(blender.reason, 503, 'NO_BLENDER');
    const { resolveFfmpeg } = require('./ffmpeg');
    const ff = resolveFfmpeg();
    if (!ff.available) throw refuse(ff.reason || 'ffmpeg is not available', 503, 'NO_FFMPEG');
    const job = { status: 'running', frame: 0, frames: p.frame_count, started_at: new Date().toISOString(), error: null };
    JOBS.set(shotId, job);
    return renderNow(shotId, p, job, setBuild.runBlender);
}

async function renderNow(shotId, p, job, runBlender) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'film-engine-previz-'));
    try {
        const rendered = await runBlender({
            mode: 'previz', out_dir: work, world_glb: p.world_glb, width: p.width, height: p.height,
            sensor_width_mm: p.sensor_width_mm, subjects: p.subjects, frames: p.frames,
        }, Math.max(600000, p.frame_count * 6000), {
            script: SCRIPT,
            onLog: chunk => { const m = /PREVIZ-FRAME (\d+)\/(\d+)/g; let x; while ((x = m.exec(chunk))) job.frame = Number(x[1]); },
        });
        job.status = 'encoding';
        const mp4 = path.join(work, 'previz.mp4');
        await encode(path.join(work, 'frames'), p.fps, mp4);

        const { saveFile } = require('./file-storage');
        const { generateId } = require('../db/database');
        const version = (db().prepare(`SELECT MAX(version) v FROM film_assets WHERE shot_id = ? AND asset_type = 'other'
            AND json_valid(metadata) AND json_extract(metadata, '$.kind') = ?`).get(shotId, KIND).v || 0) + 1;
        const code = String(p.shot_code || shotId).replace(/[^\w.-]/g, '_');
        const fileName = `${code}_previz_v${version}.mp4`;
        const filePath = saveFile(p.project_id, 'previs', fileName, fs.readFileSync(mp4));
        const metadata = { kind: KIND, fps: p.fps, frames: p.frame_count, width: p.width, height: p.height,
            world_version_id: p.world_version_id, renderer: rendered.renderer || 'blender-workbench', subjects: p.subjects.length };
        const id = generateId();
        db().prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type,
                      size_bytes, duration_ms, width, height, version, metadata)
                      VALUES (?, ?, ?, 'other', ?, ?, 'mp4', 'video/mp4', ?, ?, ?, ?, ?, ?)`)
            .run(id, p.project_id, shotId, filePath, fileName, fs.statSync(filePath).size, p.duration_ms,
                p.width, p.height, version, JSON.stringify(metadata));
        const video = rowOut(db().prepare('SELECT * FROM film_assets WHERE id = ?').get(id));
        Object.assign(job, { status: 'done', frame: p.frame_count, asset_id: id, url: video.url, finished_at: new Date().toISOString() });
        return { video, warnings: p.warnings };
    } catch (err) {
        Object.assign(job, { status: 'failed', error: err.message, finished_at: new Date().toISOString() });
        throw err;
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* a temp folder left behind is harmless */ }
    }
}

module.exports = { plan, render, list, JOBS, KIND, MAX_FRAMES, toBlender };
