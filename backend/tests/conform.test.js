/**
 * The last step: turning shots into a film.
 *
 * `assembly` has been a no-op since it was written. It returns
 *
 *   { ok: true, message: 'Assembly step: use export endpoints to finalize' }
 *
 * so an orchestrated run reports success and produces no film, and the QA
 * check named `video_master` passes by counting per-shot assets — it goes green
 * on shot 1 of N. Nothing in the codebase concatenates anything. The acceptance
 * criterion for this whole product is a screenplay reaching a finished movie,
 * and this one line is what stands in the way.
 *
 * The planner is PURE, and that is the load-bearing decision. Conforming needs
 * a media tool this repo deliberately does not depend on, so if planning and
 * executing were one function the entire feature would be untestable on any
 * machine without ffmpeg installed — including this one. Planning answers
 * "which file, in what order, with what audio, and is anything missing"; only
 * execution needs a binary.
 *
 * Set-based over the shots, because the failure that matters is silent and
 * partial: a film that renders successfully while missing shot 7 plays fine and
 * is wrong, and nobody notices until someone watches all of it.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-conform-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const conform = require('../lib/conform');

/**
 * Which asset a shot contributes, best first.
 *
 * A shot that has been graded should not be conformed from its raw clip just
 * because both exist — that silently ships the ungraded version of a shot
 * someone paid to finish.
 */
const PRECEDENCE = ['video_final', 'video_synced', 'video_raw'];

function makeFilm(shotSpecs) {
    const projectId = generateId(), sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'The Film');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);

    const shots = [];
    shotSpecs.forEach((spec, i) => {
        const shotId = generateId();
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?)`)
            .run(shotId, sceneId, spec.code, JSON.stringify({ shot_code: spec.code, camera: {} }),
                spec.duration_ms || 4000, spec.sort_order === undefined ? i : spec.sort_order);
        for (const type of (spec.assets || [])) {
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
                        VALUES (?, ?, ?, ?, ?, ?)`)
                .run(generateId(), projectId, shotId, type, `/tmp/${spec.code}_${type}.mp4`, `${spec.code}_${type}.mp4`);
        }
        shots.push({ shotId, ...spec });
    });
    return { projectId, sceneId, shots };
}

test('the precedence list is the one the planner uses', () => {
    assert.deepStrictEqual(conform.VIDEO_PRECEDENCE, PRECEDENCE,
        'the test and the planner disagree about which cut of a shot ships');
});

test('every shot contributes exactly one clip, in timeline order', () => {
    const { projectId } = makeFilm([
        { code: '1C', assets: ['video_raw'], sort_order: 2 },
        { code: '1A', assets: ['video_raw'], sort_order: 0 },
        { code: '1B', assets: ['video_raw'], sort_order: 1 },
    ]);
    const plan = conform.planConform(projectId);
    assert.strictEqual(plan.ok, true, JSON.stringify(plan));
    assert.deepStrictEqual(plan.clips.map(c => c.shot_code), ['1A', '1B', '1C'],
        'clips are not in timeline order, so the film plays out of sequence');
    assert.strictEqual(plan.clips.length, 3, 'a shot contributed more or fewer than one clip');
});

test('the best available cut of each shot is chosen', () => {
    const { projectId } = makeFilm([
        { code: '1A', assets: ['video_raw', 'video_synced', 'video_final'] },
        { code: '1B', assets: ['video_raw', 'video_synced'] },
        { code: '1C', assets: ['video_raw'] },
    ]);
    const plan = conform.planConform(projectId);
    const chosen = Object.fromEntries(plan.clips.map(c => [c.shot_code, c.asset_type]));
    assert.deepStrictEqual(chosen, { '1A': 'video_final', '1B': 'video_synced', '1C': 'video_raw' },
        'a graded shot was conformed from an earlier cut');
});

test('a missing shot refuses the conform rather than quietly shortening the film', () => {
    // The failure this test exists for: a film that renders successfully while
    // missing shot 7 plays fine and is wrong, and nobody notices until someone
    // watches all of it.
    const { projectId } = makeFilm([
        { code: '1A', assets: ['video_raw'] },
        { code: '1B', assets: [] },
        { code: '1C', assets: ['video_raw'] },
    ]);
    const plan = conform.planConform(projectId);
    assert.strictEqual(plan.ok, false, 'a film missing a shot was planned as complete');
    assert.ok(plan.missing.some(m => m.shot_code === '1B'), `the missing shot is not named: ${JSON.stringify(plan.missing)}`);
    assert.ok(/1B/.test(plan.error || ''), 'the error does not say which shot is missing');
});

test('a project with no shots at all is refused, not conformed to an empty file', () => {
    const { projectId } = makeFilm([]);
    const plan = conform.planConform(projectId);
    assert.strictEqual(plan.ok, false);
    assert.ok(/no shots/i.test(plan.error || ''), plan.error);
});

test('a project-level audio mix becomes the film master audio', () => {
    const { projectId } = makeFilm([{ code: '1A', assets: ['video_raw'] }]);
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name)
                VALUES (?, ?, 'audio_mix', '/tmp/mix.wav', 'mix.wav')`).run(generateId(), projectId);
    const plan = conform.planConform(projectId);
    assert.ok(plan.audio, 'the mix was ignored, so the film ships the clip audio instead');
    assert.ok(/mix\.wav/.test(plan.audio.file_path), plan.audio.file_path);
});

test('with no mix, the clips keep their own audio rather than going silent', () => {
    const { projectId } = makeFilm([{ code: '1A', assets: ['video_raw'] }]);
    const plan = conform.planConform(projectId);
    assert.strictEqual(plan.audio, null, 'invented an audio track that does not exist');
    assert.strictEqual(plan.keeps_clip_audio, true,
        'a film with no separate mix would be delivered silent');
});

test('the plan carries a total duration, so a conform can be sanity-checked', () => {
    const { projectId } = makeFilm([
        { code: '1A', assets: ['video_raw'], duration_ms: 4000 },
        { code: '1B', assets: ['video_raw'], duration_ms: 6000 },
    ]);
    const plan = conform.planConform(projectId);
    assert.strictEqual(plan.total_duration_ms, 10000);
});

test('the ffmpeg command is built from the plan and names every clip', () => {
    const { projectId } = makeFilm([
        { code: '1A', assets: ['video_raw'] },
        { code: '1B', assets: ['video_raw'] },
    ]);
    const plan = conform.planConform(projectId);
    const cmd = conform.buildFfmpegArgs(plan, '/tmp/out.mp4');
    assert.ok(Array.isArray(cmd.args), 'no argument list');
    const joined = cmd.args.join(' ');
    for (const code of ['1A', '1B']) {
        assert.ok(joined.includes(code), `${code} is not in the ffmpeg command`);
    }
    assert.ok(joined.includes('/tmp/out.mp4'), 'the output path is missing');
});

test('executors are probed and reported, never assumed', () => {
    // ffmpeg is not installed on every machine — it is not on this one — and a
    // conform that assumes it produces a stack trace instead of an answer.
    const probe = conform.availableExecutors();
    assert.ok(Array.isArray(probe.executors) && probe.executors.length >= 2,
        'expected at least a local and a provider executor to be considered');
    for (const e of probe.executors) {
        assert.ok(typeof e.available === 'boolean', `${e.id}: availability not determined`);
        if (!e.available) assert.ok(e.reason, `${e.id}: unavailable with no reason given`);
    }
});


// ── Wiring: assembly must stop lying ───────────────────────────────────────

const fs = require('fs');

test('assembly no longer returns a hardcoded success', () => {
    // The line this whole task exists to delete:
    //   { ok: true, message: 'Assembly step: use export endpoints to finalize' }
    // An orchestrated run reported complete and produced no film at all.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');
    assert.ok(!/Assembly step: use export endpoints to finalize/.test(src),
        'assembly still returns the placeholder, so a run reports a film it did not make');
    assert.ok(/conform/i.test(src), 'assembly never mentions the conform');
});

test('a conform that cannot run says so instead of reporting success', () => {
    // The three states must stay distinguishable. Collapsing "nothing
    // happened" into ok:true is the original defect.
    const { projectId } = makeFilm([{ code: '1A', assets: [] }]);
    const plan = conform.planConform(projectId);
    assert.strictEqual(plan.ok, false);
    assert.ok(plan.error, 'a refusal with no reason is indistinguishable from a bug');
    assert.ok(plan.missing.length, 'refused without naming what is missing');
});

test('the conform is reachable as its own route, not only as a pipeline step', () => {
    // A director conforms a cut far more often than they run the whole
    // pipeline, and making them run nine steps to get one file is what gets
    // worked around with ffmpeg by hand.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'production-reports.js'), 'utf8');
    assert.ok(/conform/.test(src), 'no conform route');
});
