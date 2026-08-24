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
/**
 * The whole film's clips, joined.
 *
 * The concat itself lives in lib/ffmpeg.js and is shared with the sequence
 * stitch: two concat filters is how one of them acquires the pix_fmt fix and
 * the other does not, and the one that misses it plays everywhere except the
 * NLE the director actually uses. What stays here is the CLIP SELECTION, which
 * is a statement about this film rather than about encoding.
 */
function buildFfmpegArgs(plan, outputPath) {
    const { buildConcatArgs, resolveFfmpeg } = require('./ffmpeg');
    const cmd = buildConcatArgs(plan.clips, outputPath, { fps: plan.fps, audio: plan.audio });
    const found = resolveFfmpeg();
    return { bin: found.bin || 'ffmpeg', args: cmd.args, output: outputPath };
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

    /*
     * Asked of the SAME resolver the stitch uses. This ran its own
     * `execFileSync('ffmpeg')`, so it could only ever see one of the three
     * places an encoder lives — an install with FFMPEG_PATH set, or with only
     * the bundled binary, would be told nothing was available while the stitch
     * beside it worked perfectly.
     */
    const found = require('./ffmpeg').resolveFfmpeg();
    executors.push({
        id: found.available ? `ffmpeg (${found.source})` : 'local-ffmpeg',
        available: found.available,
        reason: found.available ? null : found.reason,
    });

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

/**
 * Actually produce the film.
 *
 * Returns a RESULT, never throws for a missing tool: "nothing installed can do
 * this" is an answer a director needs, and a stack trace is not one. The three
 * states — produced, refused, no executor — stay distinct, because collapsing
 * any of them into success is the exact defect this replaces.
 */
async function runConform(projectId, options) {
    const opts = options || {};
    const plan = planConform(projectId);
    if (!plan.ok) return { ok: false, state: 'missing_shots', plan, error: plan.error };

    const probe = availableExecutors();
    const executor = probe.executors.find(e => e.available);
    if (!executor) {
        return {
            ok: false, state: 'no_executor', plan, executors: probe.executors,
            error: 'Nothing available can conform the film: '
                + probe.executors.map(e => `${e.id} (${e.reason})`).join('; '),
        };
    }

    if (executor.id === 'provider-stitch') {
        // The provider path exists in the registry but no adapter implements a
        // whole-film stitch today. Saying so beats pretending to try.
        return {
            ok: false, state: 'no_executor', plan, executors: probe.executors,
            error: 'Only a provider executor is available, and no provider adapter implements a '
                + 'whole-film conform yet. Install ffmpeg to conform locally.',
        };
    }

    const path = require('path');
    const fs = require('fs');
    const { getProjectDir } = require('./file-storage');
    const dir = typeof getProjectDir === 'function'
        ? getProjectDir('video', projectId)
        : path.join(process.env.FILM_DATA_DIR || 'data', 'video', projectId);
    fs.mkdirSync(dir, { recursive: true });

    const outputPath = path.join(dir, `${opts.filename || 'film_master'}.mp4`);
    const cmd = buildFfmpegArgs(plan, outputPath);

    try {
        execFileSync(cmd.bin, cmd.args, { stdio: 'pipe', timeout: opts.timeoutMs || 30 * 60 * 1000 });
    } catch (err) {
        return { ok: false, state: 'failed', plan, error: `ffmpeg failed: ${String(err.stderr || err.message).slice(0, 400)}` };
    }

    const db = database();
    const { generateId } = require('../db/database');
    const assetId = generateId();
    // asset_type must be a value the CHECK permits; the project master is
    // distinguished by metadata.kind, the same discriminator the 3D work uses
    // because the CHECK cannot be widened in place.
    db.prepare(
        `INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, version, metadata)
         VALUES (?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', 1, ?)`)
        .run(assetId, projectId, outputPath, path.basename(outputPath),
            JSON.stringify({ kind: 'project_master', clips: plan.clips.length, duration_ms: plan.total_duration_ms }));

    return { ok: true, state: 'produced', plan, asset_id: assetId, output: outputPath, executor: executor.id };
}

module.exports = { planConform, buildFfmpegArgs, availableExecutors, runConform, VIDEO_PRECEDENCE };
