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
 * THE PROJECT-LEVEL ARTEFACTS, FOUND ONE WAY.
 *
 * The broadcast QC and the conform each asked "which mix is the film's" and
 * each took ANY `audio_mix` on the project. Every mix the engine writes today
 * carries a shot_id — it is one shot's mix — so the QC passed on a single
 * mixed shot, and the conform would have laid that shot's sound under every
 * other shot and reported success. The rule: the project mix is an `audio_mix`
 * that belongs to NO shot; the project master is a `video_final` marked
 * `kind: project_master` (the CHECK cannot be widened, so metadata carries the
 * discriminator — the 3D precedent). Stated here and read by both.
 */
const PROJECT_MASTER_KIND = 'project_master';

function findProjectMaster(db, projectId) {
    return db.prepare(
        `SELECT id, file_path, file_name, version, duration_ms FROM film_assets
          WHERE project_id = ? AND shot_id IS NULL AND asset_type = 'video_final'
            AND metadata LIKE ?
       ORDER BY version DESC, created_at DESC LIMIT 1`).get(projectId, `%"kind":"${PROJECT_MASTER_KIND}"%`) || null;
}

/*
 * A score session's bounce master is also an `audio_mix` belonging to no shot,
 * and it is NOT the film's soundtrack: it is one session's music. Read as the
 * project mix it replaced the whole film's audio — dialogue included — with a
 * score, the moment any session was bounced. It reaches the film only through
 * an approval (lib/music-approval.js), laid over the film's own audio.
 */
function findProjectMix(db, projectId) {
    return db.prepare(
        `SELECT id, file_path, file_name, version FROM film_assets
          WHERE project_id = ? AND shot_id IS NULL AND asset_type = 'audio_mix'
            AND NOT (json_valid(COALESCE(metadata, '')) AND COALESCE(json_extract(metadata, '$.kind'), '') IN ('bounce_master', 'bounce_stem'))
       ORDER BY version DESC, created_at DESC LIMIT 1`).get(projectId) || null;
}

/**
 * Work out what the film is made of.
 *
 * Refuses rather than shortens. A film that renders successfully while missing
 * shot 7 plays fine and is wrong, and nobody finds out until somebody watches
 * all of it — which on a feature is the most expensive possible moment.
 */
function planConform(projectId) {
    const db = database();
    const project = db.prepare(
        'SELECT id, title, target_fps, target_resolution, target_duration_ms FROM film_projects WHERE id = ?')
        .get(projectId);
    if (!project) return { ok: false, error: 'Project not found', clips: [], missing: [] };

    const shots = db.prepare(
        `SELECT sh.id, sh.shot_code, sh.duration_ms, sh.sort_order,
                s.scene_number
           FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ?
          ORDER BY ${require('./running-order').ORDER_BY_SQL}`).all(projectId);

    if (!shots.length) {
        return { ok: false, error: 'This project has no shots, so there is no film to conform.', clips: [], missing: [] };
    }

    /*
     * A clip that contains several shots is laid down ONCE, at the first of
     * them, and the shots inside it are neither cut to again nor reported
     * missing. Without this the master repeats the same footage three times, or
     * refuses to build at all because 1B and 1C look like missing footage the
     * director is told to generate — footage they already have.
     */
    const { coverageFor, foldShots, measuredDurations } = require('./clip-coverage');
    // How long the clips actually are: every card's duration_ms is 0 on a real
    // project, so a conform built from the card produces a zero-length film.
    const folded = foldShots(shots, coverageFor(db, projectId), measuredDurations(db, projectId));

    const clips = [], missing = [];
    for (const shot of folded.shots) {
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
            // The clip's own measured length where the fold supplied one, so a
            // nine-second clip is not laid into a three-second slot and every
            // cut after it pulled six seconds early.
            duration_ms: shot.duration_ms || 0,
            ...(shot.covers ? { covers: shot.covers } : {}),
        });
    }

    // A finished PROJECT mix is the master audio when one exists. Otherwise
    // the clips keep their own audio — inventing a silent track would deliver
    // a mute film that looks successful. A per-shot mix is not the film's:
    // laid under the whole picture it plays one shot's sound over every other.
    const mix = findProjectMix(db, projectId);

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

    /*
     * THE APPROVED SCORE (MUS-020), laid once over the film's audio at the
     * start of its picture's first shot in THIS running order. A finished
     * project mix is the whole soundtrack and is taken to contain the score,
     * so the score is not laid a second time over it — and the report says so.
     */
    const approval = require('./music-approval');
    const scored = approval.approvedScores(db, projectId);
    const placed = approval.placeScores(approval.entriesFromClips(clips), scored.scores);
    const reports = [...scored.reports, ...placed.reports];
    if (mix) reports.push(...approval.shadowedByProjectMix(placed.placements));
    plan.score = { placements: mix ? [] : placed.placements, reports };
    // The rights policy at final export (MUS-022), over the score the master will carry.
    plan.rights = placed.placements.length && !mix ? require('./music-rights').evaluate(db, placed.placements.map(p => p.asset_id), 'final_export') : null;

    if (missing.length) {
        plan.error = `Cannot conform: ${missing.length} shot(s) have no video — `
            + `${missing.map(m => m.shot_code).join(', ')}. `
            + 'Generate them, or remove them from the timeline. A film missing a shot plays fine and is wrong.';
    }

    /*
     * THE RUNTIME IS A TARGET, NOT AN OUTCOME.
     *
     * A film runs as long as it runs. A commercial is BOUGHT by the second: a
     * :30 that arrives at 31.4s is rejected by the station, and one that arrives
     * at 29.6s has paid for airtime it did not use. So the length is checked
     * here, before anything is muxed, and it REFUSES rather than trimming — the
     * doctrine this file already follows for a missing shot. Silently shortening
     * would deliver a spot the director did not cut.
     *
     * A target of 0 is "no target", which is every film ever made in this tool.
     * `over_by_ms` is null for them rather than an overage against nothing: a
     * check that fires on every existing project is one switched off the day it
     * ships, taking the real case with it.
     */
    const target = Number(project.target_duration_ms) || 0;
    plan.target_duration_ms = target;
    plan.over_by_ms = null;
    if (target > 0) {
        const delta = plan.total_duration_ms - target;
        plan.over_by_ms = delta;
        // One frame of tolerance, stated rather than assumed: a cut is measured
        // in whole frames and a target expressed in milliseconds cannot always
        // land on one exactly.
        const tolerance = Math.ceil(1000 / (plan.fps || 24));
        if (Math.abs(delta) > tolerance) {
            plan.ok = false;
            const over = delta > 0;
            plan.error = `Cannot conform: this cut runs ${(plan.total_duration_ms / 1000).toFixed(1)}s `
                + `against a ${(target / 1000).toFixed(1)}s target — `
                + `${over ? 'over' : 'under'} by ${(Math.abs(delta) / 1000).toFixed(1)}s. `
                + (over
                    ? 'A spot longer than the slot it was bought for is rejected by the station. '
                      + 'Trim the cut; nothing here will shorten it for you.'
                    : 'A spot shorter than its slot has paid for airtime it does not use. '
                      + 'Extend a hold, or lengthen a shot.');
        }
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
/**
 * THE WALK: every executor, what became of it, and why.
 *
 * `lib/image-fallback.js` reports `_chain` on failure for a reason that holds
 * here one level down: a message quoting only the executor that was reached
 * sends the reader to the wrong fix. A refused join said "cannot read 1B.mp4"
 * and nothing about the provider path sitting untried beside it. So a failure
 * lists EVERY probed executor — tried with its error, or not tried with the
 * reason — in the probe's own order, and the error a person reads names each.
 */
const PROVIDER_STITCH_UNBUILT = 'no provider adapter implements a whole-film conform yet';

function walkFrom(executors, chosen, attempt) {
    return executors.map(e => {
        if (!e.available) return { executor: e.id, available: false, attempted: false, ok: null, error: null, reason: e.reason };
        if (chosen && e.id !== chosen.id) {
            return { executor: e.id, available: true, attempted: false, ok: null, error: null,
                reason: `not tried: ${chosen.id} was chosen first` };
        }
        if (!attempt) {
            return { executor: e.id, available: true, attempted: false, ok: null, error: null,
                reason: e.id === 'provider-stitch' ? PROVIDER_STITCH_UNBUILT : 'not tried' };
        }
        return { executor: e.id, available: true, attempted: true, ok: !!attempt.ok, error: attempt.ok ? null : attempt.error, reason: null };
    });
}

function describeWalk(walk) {
    return walk.map(w => w.attempted
        ? `${w.executor}: tried, ${w.ok ? 'ok' : w.error}`
        : `${w.executor}: not tried, ${w.reason}`).join('; ');
}

async function runConform(projectId, options) {
    const opts = options || {};
    const plan = planConform(projectId);
    // Refused at the plan: no executor was consulted, and the walk says so
    // rather than pretending one was.
    if (!plan.ok) return { ok: false, state: 'missing_shots', plan, error: plan.error, walk: [], walk_stage: 'plan' };
    if (plan.rights && !plan.rights.ok && opts.ignore_rights !== true) {
        return { ok: false, state: 'rights_blocked', plan, walk: [], walk_stage: 'plan', rights: plan.rights,
            error: `The rights policy blocks the final master: ${plan.rights.blocked.map(i => `${i.name} (${i.status})`).join('; ')}. Clear them in the rights register, or pass ignore_rights to conform anyway.` };
    }

    // Injectable so the no-executor path can be exercised on a machine that
    // has one — the encoder probe caches an available answer for the process.
    const probe = typeof opts.probe === 'function' ? opts.probe() : availableExecutors();
    const executor = probe.executors.find(e => e.available);
    if (!executor) {
        const walk = walkFrom(probe.executors, null, null);
        return {
            ok: false, state: 'no_executor', plan, executors: probe.executors, walk, walk_stage: 'execute',
            error: `Nothing available can conform the film — ${describeWalk(walk)}`,
        };
    }

    if (executor.id === 'provider-stitch') {
        // The provider path exists in the registry but no adapter implements a
        // whole-film stitch today. Saying so beats pretending to try.
        const walk = walkFrom(probe.executors, executor, null);
        return {
            ok: false, state: 'no_executor', plan, executors: probe.executors, walk, walk_stage: 'execute',
            error: `Only a provider executor is available, and ${PROVIDER_STITCH_UNBUILT}. `
                + `Install ffmpeg to conform locally — ${describeWalk(walk)}`,
        };
    }

    const path = require('path');
    const fs = require('fs');
    const { ensureDir, getFileUrl } = require('./file-storage');
    const { stitchClips, inspectMedia } = require('./ffmpeg');

    /*
     * WHERE THE SERVING ROUTE WILL LOOK. This wrote to `data/video/<project>`
     * relative to the process cwd, through a `getProjectDir` that file-storage
     * has never exported, while `/film/video/:project/:file` reads from
     * DATA_DIR. With FILM_DATA_DIR unset those are different directories: the
     * conform reported success and the master 404'd.
     */
    const dir = ensureDir(projectId, 'video');
    const filename = `${opts.filename || 'film_master'}.mp4`;
    const outputPath = path.join(dir, filename);

    /*
     * THROUGH THE ONE JOIN. Running buildFfmpegArgs directly skipped the clip
     * inspection the sequence stitch does, so the concat graph asked every
     * input for an audio stream — and a generated clip has none. Any film
     * containing one silent clip failed to conform at all, with an error that
     * quoted the ffmpeg banner rather than the line that said why.
     */
    let joined = await stitchClips(plan.clips, outputPath, {
        fps: plan.fps, audio: plan.audio, timeoutMs: opts.timeoutMs,
    });
    // The approved score over the joined film, once, at its offset (MUS-020).
    if (joined.ok && plan.score && plan.score.placements.length) {
        const mixed = require('./music-approval').mixScoreIntoFilm(outputPath, plan.score.placements, { timeoutMs: opts.timeoutMs });
        if (!mixed.ok) joined = { ok: false, state: 'failed', error: mixed.error };
    }
    if (!joined.ok) {
        const walk = walkFrom(probe.executors, executor, { ok: false, error: joined.error });
        return {
            ok: false, state: joined.state, plan, executors: probe.executors, walk, walk_stage: 'execute',
            error: `${joined.error} — ${describeWalk(walk)}`,
        };
    }

    // Measured from the file, never copied from the plan: a master registered
    // from a broken encode must not look identical to a good one.
    const seen = inspectMedia(outputPath);
    const durationMs = seen.ok ? Math.round(seen.durationSeconds * 1000) : null;
    const sizeBytes = fs.statSync(outputPath).size;

    const db = database();
    const { generateId } = require('../db/database');
    const assetId = generateId();
    // asset_type must be a value the CHECK permits; the project master is
    // distinguished by metadata.kind, the same discriminator the 3D work uses
    // because the CHECK cannot be widened in place.
    const KIND = '%"kind":"project_master"%';
    const prior = db.prepare(
        `SELECT id, file_path, version FROM film_assets
          WHERE project_id = ? AND asset_type = 'video_final' AND metadata LIKE ?`).all(projectId, KIND);
    const version = prior.reduce((n, r) => Math.max(n, Number(r.version) || 0), 0) + 1;
    /*
     * REPLACES, NEVER ACCUMULATES. The file is written to the same name and
     * overwrites, so a row that pointed at it now describes bytes that no
     * longer exist — a folder of near-identical masters is how the wrong one
     * gets delivered, and a row whose metadata lies about its own file is
     * worse than no row. A master written under ANOTHER filename still exists
     * on disk and keeps its row.
     */
    const replaced = prior.filter(r => r.file_path === outputPath).map(r => r.id);
    const write = db.transaction(() => {
        for (const id of replaced) db.prepare('DELETE FROM film_assets WHERE id = ?').run(id);
        db.prepare(
            `INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type,
                                      size_bytes, duration_ms, width, height, version, metadata)
             VALUES (?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', ?, ?, ?, ?, ?, ?)`)
            .run(assetId, projectId, outputPath, filename, sizeBytes, durationMs,
                seen.ok ? seen.width : null, seen.ok ? seen.height : null, version,
                JSON.stringify({
                    kind: 'project_master', clips: plan.clips.length,
                    duration_ms: durationMs === null ? plan.total_duration_ms : durationMs,
                    audio: plan.audio ? 'project_mix' : 'clip_audio',
                    score: (plan.score && plan.score.placements || []).map(p => ({ session_id: p.session_id, asset_id: p.asset_id, offset_ms: p.offset_ms })),
                }));
    });
    write();

    return {
        ok: true, state: 'produced', plan, asset_id: assetId, output: outputPath,
        url: getFileUrl('video', projectId, filename, version),
        version, replaced, duration_ms: durationMs, size_bytes: sizeBytes,
        executor: executor.id,
    };
}

module.exports = {
    planConform, buildFfmpegArgs, availableExecutors, runConform, VIDEO_PRECEDENCE,
    findProjectMaster, findProjectMix, PROJECT_MASTER_KIND,
};
