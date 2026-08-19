/**
 * Turning shots into a film.
 *
 * `assembly` has been a no-op since it was written — it returns "use export
 * endpoints to finalize" and produces nothing — so an orchestrated run reports
 * success and there is no movie. The QA check named `video_master` passes by
 * counting per-shot assets, so it goes green on shot 1 of N. Nothing in the
 * codebase concatenates anything.
 *
 * PLANNING IS PURE AND SEPARATE FROM EXECUTING, which is the load-bearing
 * decision here. Conforming needs a media tool this repo deliberately does not
 * depend on (ADR-002: one dependency), so if the two were one function the
 * whole feature would be untestable on any machine without ffmpeg installed —
 * including the one it was written on. Planning answers "which file, in what
 * order, with what audio, and is anything missing"; only execution needs a
 * binary, and execution is chosen from what is actually present rather than
 * assumed.
 */

const { execFileSync } = require('child_process');

/**
 * Which cut of a shot ships, best first.
 *
 * A graded shot must not be conformed from its raw clip just because both
 * exist — that silently delivers the unfinished version of a shot someone paid
 * to finish, and it looks identical in a file listing.
 */
const VIDEO_PRECEDENCE = ['video_final', 'video_synced', 'video_raw'];

function database() { return require('../db/database').db; }

/**
 * Work out what the film is made of.
 *
 * Refuses rather than shortens. A film that renders successfully while missing
 * shot 7 plays fine and is wrong, and nobody finds out until somebody watches
 * all of it — which on a feature is the most expensive possible moment.
 */
function planConform(projectId) {
    const db = database();
    const project = db.prepare('SELECT id, title, target_fps, target_resolution FROM film_projects WHERE id = ?')
        .get(projectId);
    if (!project) return { ok: false, error: 'Project not found', clips: [], missing: [] };

    const shots = db.prepare(
        `SELECT sh.id, sh.shot_code, sh.duration_ms, sh.sort_order,
                s.scene_number
           FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ?
          ORDER BY sh.sort_order, CAST(s.scene_number AS INTEGER), sh.shot_code`).all(projectId);

    if (!shots.length) {
        return { ok: false, error: 'This project has no shots, so there is no film to conform.', clips: [], missing: [] };
    }

    const clips = [], missing = [];
    for (const shot of shots) {
        const asset = db.prepare(
            `SELECT id, asset_type, file_path, file_name FROM film_assets
              WHERE shot_id = ? AND asset_type IN (${VIDEO_PRECEDENCE.map(() => '?').join(',')})
           ORDER BY CASE asset_type ${VIDEO_PRECEDENCE.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ')} END,
                    version DESC, created_at DESC
              LIMIT 1`).get(shot.id, ...VIDEO_PRECEDENCE);

        if (!asset) { missing.push({ shot_id: shot.id, shot_code: shot.shot_code }); continue; }
        clips.push({
            shot_id: shot.id,
            shot_code: shot.shot_code,
            scene: String(shot.scene_number),
            asset_id: asset.id,
            asset_type: asset.asset_type,
            file_path: asset.file_path,
            duration_ms: shot.duration_ms || 0,
        });
    }

    // A finished mix is the master audio when one exists. Otherwise the clips
    // keep their own audio — inventing a silent track would deliver a mute
    // film that looks successful.
    const mix = db.prepare(
        `SELECT id, file_path, file_name FROM film_assets
          WHERE project_id = ? AND asset_type = 'audio_mix'
       ORDER BY version DESC, created_at DESC LIMIT 1`).get(projectId);

    const plan = {
        ok: missing.length === 0,
        project_id: projectId,
        title: project.title,
        clips,
        missing,
        audio: mix ? { asset_id: mix.id, file_path: mix.file_path } : null,
        keeps_clip_audio: !mix,
        total_duration_ms: clips.reduce((n, c) => n + (c.duration_ms || 0), 0),
        fps: project.target_fps || 24,
        resolution: project.target_resolution || '1920x1080',
    };

    if (missing.length) {
        plan.error = `Cannot conform: ${missing.length} shot(s) have no video — `
            + `${missing.map(m => m.shot_code).join(', ')}. `
            + 'Generate them, or remove them from the timeline. A film missing a shot plays fine and is wrong.';
    }
    return plan;
}

/**
 * The ffmpeg invocation for a plan.
 *
 * Built as an argument ARRAY, never a shell string: a shot code or a title with
 * a quote in it would otherwise be a command injection, and file paths come
 * from the database.
 */
function buildFfmpegArgs(plan, outputPath) {
    const args = [];
    for (const clip of plan.clips) { args.push('-i', clip.file_path); }
    if (plan.audio) args.push('-i', plan.audio.file_path);

    const n = plan.clips.length;
    // concat filter over the decoded streams rather than the demuxer: the clips
    // come from different generators and need not share codec parameters, and
    // the demuxer silently produces garbage when they do not.
    const streams = plan.clips.map((_, i) => plan.audio ? `[${i}:v:0]` : `[${i}:v:0][${i}:a:0]`).join('');
    if (plan.audio) {
        args.push('-filter_complex', `${streams}concat=n=${n}:v=1:a=0[outv]`);
        args.push('-map', '[outv]', '-map', `${n}:a:0`, '-shortest');
    } else {
        args.push('-filter_complex', `${streams}concat=n=${n}:v=1:a=1[outv][outa]`);
        args.push('-map', '[outv]', '-map', '[outa]');
    }
    args.push('-r', String(plan.fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    args.push('-y', outputPath);

    return { bin: 'ffmpeg', args, output: outputPath };
}

/**
 * Which executors could actually do this, and why the others cannot.
 *
 * Probed, never assumed. ffmpeg is not installed on every machine — it is not
 * installed on the one this was written on — and a conform that assumes it
 * produces a stack trace where an answer belongs.
 */
function availableExecutors() {
    const executors = [];

    let localReason = null, localOk = false;
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
        localOk = true;
    } catch (err) {
        localReason = 'ffmpeg is not on PATH. Install it, or use a provider that can stitch.';
    }
    executors.push({ id: 'local-ffmpeg', available: localOk, reason: localOk ? null : localReason });

    // The provider path: the same stitch payload multi-clip shots already use.
    let providerOk = false, providerReason = null;
    try {
        const { resolveGenerator } = require('./providers');
        const adapter = resolveGenerator('post', {});
        providerOk = !!adapter;
        if (!providerOk) providerReason = 'no provider serves the post capability';
    } catch (err) {
        providerReason = `provider lookup failed: ${err.message}`;
    }
    executors.push({ id: 'provider-stitch', available: providerOk, reason: providerOk ? null : providerReason });

    return { executors, any: executors.some(e => e.available) };
}

module.exports = { planConform, buildFfmpegArgs, availableExecutors, VIDEO_PRECEDENCE };
