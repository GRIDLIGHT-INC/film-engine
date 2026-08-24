/**
 * WHERE A GENERATED MEDIA FILE GOES, said once.
 *
 * capability → extension, → film_assets.asset_type, → directory and → scope
 * existed THREE times: PERSIST_EXT and ASSET_TYPE in routes/pipeline.js and
 * SUBDIR/serveDir in lib/capability-payloads.js. The comment above ASSET_TYPE
 * already recorded what a mismatch costs — a wrong asset_type fails the CHECK
 * at insert and turns a successful, paid-for generation into a failed step —
 * and three copies of one fact is three chances to write it down wrong.
 *
 * It became load-bearing when imports arrived. An importer needs every one of
 * these to put an uploaded clip exactly where a generated one goes, and a
 * fourth copy is precisely how the next capability ends up importable to the
 * wrong directory with an asset_type nothing reads.
 *
 * `scope` is NOT declared here — it is read from PIPELINE_STEPS below, because
 * the orchestrator already owns the answer and an importer that disagreed would
 * attach a scene-wide music bed to a single shot.
 */

const { PIPELINE_STEPS } = require('./pipeline-engine');

/*
 * The capability whose output each step produces. Only `keyframe` differs from
 * its capability name; the rest are 1:1, and mapping them explicitly is what
 * lets scope be derived rather than retyped.
 */
const STEP_FOR_CAPABILITY = Object.freeze({
    image: 'keyframe', video: 'video', voice: 'voice', lipsync: 'lipsync',
    music: 'music', sfx: 'sfx', ambient: 'ambient', post: 'post',
});

/** What each capability writes, and what a person could hand us instead. */
const STORAGE = Object.freeze({
    image: { assetType: 'keyframe', ext: 'png', subdir: 'storyboards', serveDir: 'images', media: 'image' },
    video: { assetType: 'video_raw', ext: 'mp4', subdir: 'video', serveDir: 'videos', media: 'video' },
    voice: { assetType: 'audio_dialogue', ext: 'wav', subdir: 'audio', serveDir: 'audio', media: 'audio' },
    lipsync: { assetType: 'video_synced', ext: 'mp4', subdir: 'video', serveDir: 'videos', media: 'video' },
    music: { assetType: 'audio_music', ext: 'wav', subdir: 'music', serveDir: 'music', media: 'audio' },
    sfx: { assetType: 'audio_sfx', ext: 'wav', subdir: 'music', serveDir: 'music', media: 'audio' },
    ambient: { assetType: 'audio_ambient', ext: 'wav', subdir: 'music', serveDir: 'music', media: 'audio' },
    post: { assetType: 'video_final', ext: 'mp4', subdir: 'video', serveDir: 'videos', media: 'video' },
});

const SCOPE = new Map(PIPELINE_STEPS.map(s => [s.id, s.scope]));

const MEDIA_KINDS = Object.freeze(Object.fromEntries(
    Object.entries(STORAGE).map(([capability, spec]) => [capability, Object.freeze({
        ...spec,
        capability,
        step: STEP_FOR_CAPABILITY[capability],
        // The orchestrator's own answer, never a second one.
        scope: SCOPE.get(STEP_FOR_CAPABILITY[capability]) || 'shot',
    })])
));

/** capability → file extension. */
const PERSIST_EXT = Object.freeze(Object.fromEntries(
    Object.entries(MEDIA_KINDS).map(([k, v]) => [k, v.ext])));

/** capability → film_assets.asset_type. Values the CHECK actually permits. */
const ASSET_TYPE = Object.freeze(Object.fromEntries(
    Object.entries(MEDIA_KINDS).map(([k, v]) => [k, v.assetType])));

/** capability → storage directory, and the directory it is served from. */
const SUBDIR = Object.freeze(Object.fromEntries(
    Object.entries(MEDIA_KINDS).map(([k, v]) => [k, v.subdir])));
const SERVE_DIR = Object.freeze(Object.fromEntries(
    Object.entries(MEDIA_KINDS).map(([k, v]) => [k, v.serveDir])));

module.exports = { MEDIA_KINDS, PERSIST_EXT, ASSET_TYPE, SUBDIR, SERVE_DIR, STEP_FOR_CAPABILITY };
