/**
 * Shared provider-payload construction (Phase 0).
 *
 * Before this module there were two ways a generation request got built:
 *
 *   the per-domain route  -> loaded context, called a prompt builder, applied
 *                            consistency, sent a real payload
 *   the orchestrator      -> sent { shot_id, scene_id, project_id, step }
 *
 * The second one is not a shortcut, it is a defect: routes/pipeline.js was
 * asking image/video/voice generators to produce a shot from four ids and no
 * prompt. Every capability now builds through CAPABILITY_BUILDERS here, so the
 * orchestrator, the routes, and (in Phase 2) the flow canvas cannot drift.
 *
 * Three asymmetries are deliberate and must not be flattened:
 *
 *   cardinality  voice and sfx are one-context-to-many-payloads and return
 *                ARRAYS. Returning a single object silently drops every
 *                dialogue line after the first.
 *   scope        music and ambient are scene-scoped and build with no shot in
 *                context; requiring one forces callers to pick arbitrarily.
 *   sub-types    post has four (upscale, face_restore, color_grade, composite)
 *                and the orchestrated step names none, so it defaults.
 *
 * A builder takes a CONTEXT, never an id, so it is exercisable without a
 * database. Anything that reads the DB (loadShotContext, consistency lookups)
 * lazy-requires it, keeping `require('./capability-payloads')` side-effect free.
 */

const { buildStoryboardPrompt } = require('./storyboard-prompt');
const { buildVideoPayload } = require('./video-prompt');
const { extractDialogue, buildVoicePayload } = require('./dialogue-builder');
const { buildMusicPrompt, buildSFXPrompts, buildAmbientPrompt } = require('./music-prompt');

// Applying an already-built consistency context is pure, so it imports directly.
// consistency-context.js itself requires db/database at module scope and is
// pulled in only where a profile actually has to be read (loadShotContext).
const { applyConsistencyToImagePayload, applyConsistencyToVoicePayload } = require('./consistency-apply');
const consistency = () => require('./consistency-context');
const storage = () => require('./file-storage');

// Defaults lifted verbatim from routes/storyboard.js:callImageGen so the
// extraction is behaviour-preserving rather than an opportunity to retune.
const IMAGE_DEFAULTS = { model: 'sdxl', width: 1024, height: 1024, steps: 30, guidance_scale: 7.5 };

const LIPSYNC_DEFAULTS = { model: 'wav2lip', quality: 'high' };

// Which post sub-type the single orchestrated `post` step runs. Composite is the
// existing full pipeline, so an unconfigured run keeps doing what it did.
const DEFAULT_POST_JOB_TYPE = 'composite';

/** Fail with a message that names the capability and what was missing. */
function requireCtx(ctx, fields, capability) {
    const missing = fields.filter(f => !ctx || !ctx[f]);
    if (missing.length) {
        throw new Error(`cannot build ${capability} payload: context is missing ${missing.join(', ')}`);
    }
}

/**
 * A step cannot be built because an upstream artefact does not exist yet — no
 * rendered video to lip-sync, no dialogue track to sync against.
 *
 * Tagged distinctly from a malformed context because callers should treat the
 * two differently: a broken context is a bug worth failing and retrying, while
 * a missing prerequisite is simply work that is not ready. The orchestrator
 * skips these rather than burning three retries with exponential backoff on a
 * condition no retry can change.
 */
function preconditionError(message) {
    const err = new Error(message);
    err.code = 'PRECONDITION';
    return err;
}

/**
 * Shape an /image request. Shared by the `image` capability builder and by the
 * storyboard route, so there is exactly one definition of the request body.
 */
/**
 * Pixel dimensions for a project's delivery aspect, at roughly the pixel count
 * IMAGE_DEFAULTS was tuned for.
 *
 * The defaults were a fixed 1024x1024, so a 2.39:1 production got square
 * keyframes -- and a keyframe is the init_image for the video pass, so the
 * wrong frame shape propagates into every clip. A storyboard's whole job is to
 * show what will be in frame, which a square cannot do for a scope film.
 */
function dimensionsForAspect(aspect, fallbackW, fallbackH) {
    const m = String(aspect || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
    if (!m) return { width: fallbackW, height: fallbackH };
    const ratio = Number(m[1]) / Number(m[2]);
    if (!Number.isFinite(ratio) || ratio <= 0) return { width: fallbackW, height: fallbackH };

    const targetPixels = fallbackW * fallbackH;
    const round8 = n => Math.max(256, Math.round(n / 8) * 8);
    return {
        width: round8(Math.sqrt(targetPixels * ratio)),
        height: round8(Math.sqrt(targetPixels / ratio)),
    };
}

function imageRequestPayload(fields) {
    const f = fields || {};
    // An explicit width/height still wins; otherwise follow the project's frame.
    const dims = (f.width && f.height)
        ? { width: f.width, height: f.height }
        : dimensionsForAspect(f.aspect_ratio, IMAGE_DEFAULTS.width, IMAGE_DEFAULTS.height);

    const payload = {
        prompt: f.prompt,
        negative_prompt: f.negative_prompt,
        model: f.model || IMAGE_DEFAULTS.model,
        width: dims.width,
        height: dims.height,
        steps: f.steps || IMAGE_DEFAULTS.steps,
        guidance_scale: f.guidance_scale || IMAGE_DEFAULTS.guidance_scale,
        seed: f.seed === undefined ? null : f.seed,
        stream: false,
    };

    if (f.ip_adapter_image) {
        payload.ip_adapter_image = f.ip_adapter_image;
        payload.ip_adapter_weight = f.ip_adapter_weight || 0.7;
    }
    if (Array.isArray(f.reference_images) && f.reference_images.length > 0) {
        payload.reference_images = f.reference_images;
    }
    if (Array.isArray(f.input_refs) && f.input_refs.length > 0) {
        payload.input_refs = f.input_refs;
    }
    return payload;
}

/** Local asset URL, preferring a path the asset row already carries. */
function assetUrl(asset, subdir, projectId) {
    if (asset.file_path) return asset.file_path;
    return storage().getFileUrl(subdir, projectId, asset.file_name);
}

function projectIdOf(ctx) {
    if (ctx.scene && ctx.scene.project_id) return ctx.scene.project_id;
    if (ctx.project && ctx.project.id) return ctx.project.id;
    return null;
}

// ── Builders ────────────────────────────────────────────────────────────
// Each takes ctx and returns a payload (or an array of payloads).

/**
 * How much prompt the provider that will run this project's images accepts.
 *
 * Undeclared providers fall back to the strict default rather than to
 * unlimited: guessing high produces a rejected request or a silent truncation
 * at the provider's end, which is worse than trimming here where it can be
 * reported.
 */
/** The optics chosen on this project's look board, or {} if none. */
function filmOpticsFor(project) {
    try {
        const { filmOptics } = require('./look-development');
        return filmOptics(require('../db/database').db, project && project.id);
    } catch (_) { return {}; }
}

function imagePromptLimit(project) {
    try {
        const { resolveGenerator } = require('./providers');
        let config = {};
        try { config = JSON.parse((project && project.provider_config) || '{}'); } catch (_) { config = {}; }
        const adapter = resolveGenerator('image', config);
        return (adapter && Number(adapter.promptLimit) > 0) ? Number(adapter.promptLimit) : undefined;
    } catch (_) {
        return undefined;
    }
}

const CAPABILITY_BUILDERS = {
    image(ctx) {
        requireCtx(ctx, ['sceneCard', 'project'], 'image');
        const overrides = ctx.overrides || {};
        const cc = ctx.consistency || null;

        // Blocking shapes the keyframe, not only the clip. Passing it here is
        // what makes the frame a director approves the frame they staged.
        const base = buildStoryboardPrompt(ctx.sceneCard, ctx.characters, ctx.location,
            ctx.project.style_preset, {
                previs: ctx.previs || undefined,
                // Resolved here rather than passed in, so the orchestrator and
                // the per-domain route cannot disagree about how much prompt a
                // provider accepts — the same reason this file exists at all.
                maxPromptChars: imagePromptLimit(ctx.project),
                // The production's own optics, for shots nobody has blocked.
                filmOptics: filmOpticsFor(ctx.project),
                // Declared dimensions, so the prompt can say how big things are
                // relative to the frame and to each other.
                props: ctx.props || [],
                // PAR-026: markup reaches the prompt only when this shot's
                // project has opted in, or a caller has said so for this one
                // generation. Undefined otherwise — which is what keeps the
                // payload, and therefore the artefact fingerprint, byte-identical
                // for every project that has not turned it on.
                annotations: ctx.useAnnotations ? (ctx.annotations || []) : undefined,
                // The plates loadShotContext gathered, and whether this
                // provider lets the prompt name them. Undefined on a
                // hand-built context, which is what keeps every payload the
                // parity suite compares byte-identical.
                references: (ctx.references && ctx.references.length) ? ctx.references : undefined,
                tagged: ctx.tagged,
                // Two facts: whether the frame is in the payload (which licenses
                // the prompt to talk about it) and whether this provider can
                // read a tag (which decides how it is addressed).
                anchorAttached: ctx.anchorAttached || undefined,
                anchorTag: ctx.anchorTag || undefined,
            });

        const payload = imageRequestPayload({
            prompt: base.prompt,
            negative_prompt: base.negative_prompt,
            seed: overrides.seed,
            model: overrides.model,
            width: overrides.width,
            height: overrides.height,
            steps: overrides.steps,
            guidance_scale: overrides.guidance_scale,
            ip_adapter_image: overrides.ip_adapter_image,
            ip_adapter_weight: overrides.ip_adapter_weight,
            aspect_ratio: ctx.project.aspect_ratio,
            // The pictures themselves. Without this the prompt above could emit
            // @maya with nothing for it to point at, which is strictly worse
            // than having used prose.
            reference_images: ctx.references,
        });

        // The ceiling goes WITH the additions, because they are part of the
        // prompt the provider receives — enforcing it before they are appended
        // measures the wrong string.
        return cc
            ? applyConsistencyToImagePayload(payload, cc, {
                maxPromptChars: imagePromptLimit(ctx.project),
                // Subjects standing in the attached frame keep their name and
                // lose their paragraph — but only when the frame really is in
                // this payload, since shortening against a picture that did not
                // travel is the failure the contract shortening was reverted for.
                anchorCovers: ctx.anchorAttached ? (ctx.anchorCovers || []) : [],
            })
            : payload;
    },

    video(ctx) {
        requireCtx(ctx, ['sceneCard', 'project'], 'video');
        const overrides = ctx.overrides || {};
        const cc = ctx.consistency || {};

        return buildVideoPayload(ctx.sceneCard, ctx.characters, ctx.location, ctx.project.style_preset, {
            init_image: ctx.initImage || undefined,
            seed: overrides.seed !== undefined ? overrides.seed : cc.locked_seed,
            model: overrides.model,
            prompt_additions: cc.prompt_additions,
            negative_additions: cc.negative_additions,
            // No reference plates. Deliberate, and a REMOVAL rather than a fix.
            //
            // These were being sent as consistency rows carrying `file_path`
            // and no `uri`, so every adapter dropped them silently — and the
            // repair would have been the wrong move. This is image-to-video:
            // the keyframe is the init_image, and that frame was already
            // generated FROM the plates, so everything they contribute is baked
            // into it. Sending them again puts a T-pose studio photograph on a
            // seamless backdrop beside a composed street, and asks the model
            // which one is the truth.
            //
            // What the clip is conditioned on is the board and the blocking:
            // the frame below, the camera path from previs, and the director's
            // markup — which is the one thing the picture cannot carry, because
            // an arrow means "then dolly past the mailbox" rather than anything
            // visible in a still.
            input_refs: cc.input_refs,
            // Phase 3: previs travels the ONE payload path, so the orchestrator
            // and the per-domain route cannot describe the same shot
            // differently. Undefined when unblocked, which is what keeps the
            // payload byte-identical for every shot nobody has blocked.
            previs: ctx.previs || undefined,
            // The direction drawn on the board. A still can only show a state;
            // an arrow is about what happens next, which is exactly what a clip
            // has room for and a frame does not.
            annotations: ctx.useAnnotations ? (ctx.annotations || []) : undefined,
            // The delivery frame rate and size, so generation targets what the
            // film is actually delivered at rather than a constant.
            project: ctx.project,
        });
    },

    /** One payload per dialogue line. An empty dialogue array yields none. */
    voice(ctx) {
        requireCtx(ctx, ['sceneCard'], 'voice');
        const cc = ctx.consistency || null;
        const characters = ctx.characters || [];
        const voiceProfiles = ctx.voiceProfiles || [];

        return extractDialogue(ctx.sceneCard).map(line => {
            const character = characters.find(
                c => c.name && c.name.toUpperCase() === line.character.toUpperCase()
            ) || null;
            const voiceProfile = character
                ? voiceProfiles.find(vp => vp.character_id === character.id) || null
                : null;

            const payload = buildVoicePayload(line, voiceProfile, character);
            return cc ? applyConsistencyToVoicePayload(payload, cc, line.character) : payload;
        });
    },

    lipsync(ctx) {
        if (!ctx || !ctx.videoAsset) {
            throw preconditionError('cannot build lipsync payload: no rendered video asset for this shot (generate video first)');
        }
        if (!ctx.audioAsset) {
            throw preconditionError('cannot build lipsync payload: no dialogue audio asset for this shot (generate voice first)');
        }
        const overrides = ctx.overrides || {};
        const projectId = projectIdOf(ctx);

        return {
            video_url: assetUrl(ctx.videoAsset, 'video', projectId),
            audio_url: assetUrl(ctx.audioAsset, 'audio', projectId),
            model: overrides.model || LIPSYNC_DEFAULTS.model,
            quality: overrides.quality || LIPSYNC_DEFAULTS.quality,
            output_format: 'mp4',
            stream: false,
        };
    },

    /** Scene-scoped: builds with no shot in context. */
    music(ctx) {
        requireCtx(ctx, ['scene'], 'music');
        const cue = ctx.musicCue || (ctx.overrides && ctx.overrides.cue) || null;
        return buildMusicPrompt(cue, ctx.scene, ctx.project);
    },

    /** One payload per declared cue. No cues yields none. */
    sfx(ctx) {
        requireCtx(ctx, ['sceneCard', 'scene'], 'sfx');
        return buildSFXPrompts(ctx.sceneCard, ctx.scene);
    },

    /** Scene-scoped. Emits a loop plus the bed length it must cover. */
    ambient(ctx) {
        requireCtx(ctx, ['scene'], 'ambient');
        return buildAmbientPrompt(ctx.scene, ctx.location);
    },

    post(ctx) {
        if (!ctx || !ctx.videoAsset) {
            throw preconditionError('cannot build post payload: no source video asset for this shot (generate video first)');
        }
        const overrides = ctx.overrides || {};
        const jobType = overrides.job_type || DEFAULT_POST_JOB_TYPE;
        const projectId = projectIdOf(ctx);

        const base = {
            input_url: assetUrl(ctx.videoAsset, 'video', projectId),
            output_format: 'mp4',
            stream: false,
        };

        if (jobType === 'upscale') {
            return {
                ...base, type: 'upscale',
                model: overrides.model || 'realesrgan-video',
                scale_factor: overrides.scale_factor || 2,
            };
        }
        if (jobType === 'face_restore') {
            return {
                ...base, type: 'face_restore',
                face_restoration: {
                    enabled: true,
                    model: overrides.face_model || 'codeformer',
                    weight: overrides.face_weight || 0.7,
                },
            };
        }
        if (jobType === 'color_grade') {
            return {
                ...base, type: 'color_grade',
                color_grade: {
                    lut_preset: overrides.lut_preset || 'cinematic_warm',
                    film_grain: overrides.film_grain || 0.15,
                },
            };
        }
        return base;
    },
};

/**
 * Build the provider payload for a capability.
 *
 * @param {string} capability
 * @param {object} ctx - { project, scene, shot, sceneCard, characters, location,
 *                         voiceProfiles, videoAsset, audioAsset, keyframeAsset,
 *                         musicCue, initImage, consistency, overrides }
 * @returns {{ payload: object|object[], meta: object }}
 */
/**
 * Mark a payload (or every payload in a fan-out array) with what it is for, so
 * the usage meter can attribute the call without the caller passing anything.
 */
function tagSpend(payload, attribution) {
    if (!payload) return payload;
    const list = Array.isArray(payload) ? payload : [payload];
    for (const one of list) {
        if (one && typeof one === 'object') {
            Object.defineProperty(one, '__meter', {
                value: attribution, enumerable: false, writable: true, configurable: true,
            });
        }
    }
    return payload;
}

function buildCapabilityPayload(capability, ctx) {
    const builder = CAPABILITY_BUILDERS[capability];
    if (!builder) {
        throw new Error(`no payload builder registered for capability '${capability}'`);
    }

    const context = ctx || {};
    const payload = builder(context);

    // Which shot this spend belongs to, carried on the payload itself.
    //
    // The meter already knows the project (it rides in on the provider config);
    // the shot does not, and "which shot cost the most" is the question a
    // per-shot budget is for. Attached NON-ENUMERABLY so it cannot leak into a
    // provider request body — adapters pick fields explicitly, but a payload
    // that grows an unexpected key is exactly how a 400 arrives from a provider
    // for a reason nobody can see.
    tagSpend(payload, {
        projectId: projectIdOf(context),
        sceneId: context.scene ? context.scene.id : null,
        shotId: context.shot ? context.shot.id : null,
    });

    return {
        payload,
        meta: {
            capability,
            cardinality: Array.isArray(payload) ? 'many' : 'one',
            count: Array.isArray(payload) ? payload.length : 1,
            project_id: projectIdOf(context),
            scene_id: context.scene ? context.scene.id : null,
            shot_id: context.shot ? context.shot.id : null,
        },
    };
}

/**
 * Load everything a shot-scoped builder needs, in one place.
 *
 * The DB is required here rather than at module scope so that building a
 * payload from an already-loaded context needs no database at all.
 */
function loadShotContext(shotId) {
    const fs = require('fs');
    const { db } = require('../db/database');
    const { getFilePath } = storage();

    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return null;

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return null;

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { sceneCard = {}; }

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(scene.project_id);

    // Prop rows, for their declared dimensions. The prompt builder has never
    // been handed props — they reach the prompt through the consistency
    // contract, which carries no measurements — so nothing could say how big
    // an object in the frame is.
    let props = [];
    try { props = db.prepare('SELECT * FROM film_props WHERE project_id = ?').all(scene.project_id); }
    catch (_) { props = []; }
    const location = scene.location_id
        ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(scene.location_id)
        : null;
    const voiceProfiles = db.prepare(
        'SELECT vp.* FROM film_voice_profiles vp JOIN film_characters c ON c.id = vp.character_id WHERE c.project_id = ?'
    ).all(scene.project_id);

    const keyframeAsset = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type IN ('keyframe', 'storyboard') ORDER BY created_at DESC LIMIT 1"
    ).get(shotId);

    const videoAsset = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type IN ('video_raw', 'video_synced', 'video_final') ORDER BY created_at DESC LIMIT 1"
    ).get(shotId);

    const audioAsset = db.prepare(
        "SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'audio_dialogue' ORDER BY created_at DESC LIMIT 1"
    ).get(shotId);

    const musicCue = db.prepare(
        'SELECT * FROM film_music_cues WHERE scene_id = ? ORDER BY start_ms LIMIT 1'
    ).get(scene.id);

    let initImage = null;
    if (keyframeAsset && keyframeAsset.file_name) {
        try {
            const imgPath = getFilePath(scene.project_id, 'storyboards', keyframeAsset.file_name);
            if (fs.existsSync(imgPath)) initImage = fs.readFileSync(imgPath).toString('base64');
        } catch (_) { initImage = null; }
    }

    let consistencyContext = null;
    try {
        consistencyContext = consistency().buildShotReferencePayload(shot, scene, project);
    } catch (_) { consistencyContext = null; }

    // Markup on the frame. Always READ, never automatically applied: whether it
    // reaches the prompt is `useAnnotations` below, and a caller that wants to
    // preview the marks without generating from them needs them present either
    // way.
    let annotations = [];
    try {
        annotations = db.prepare(
            'SELECT * FROM film_storyboard_annotations WHERE shot_id = ? ORDER BY created_at').all(shotId)
            .map(r => {
                let points = [];
                try { const v = JSON.parse(r.points_json || '[]'); if (Array.isArray(v)) points = v; } catch (_) { points = []; }
                return { id: r.id, kind: r.kind, points, text: r.text, color: r.color, created_at: r.created_at };
            });
    } catch (_) { annotations = []; }

    // 3D blocking, when the shot has any. Null rather than absent so a caller
    // can tell "not blocked" from "context built before previs existed".
    let previs = null;
    try {
        const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
        if (row) {
            previs = {
                camera: JSON.parse(row.camera_json || '{}'),
                subject: JSON.parse(row.subject_json || '{}'),
                stage: JSON.parse(row.stage_json || '{}'),
                rig: row.rig,
                movement: row.movement,
                // The legs, not just the single movement column. A compound
                // move is what was blocked; collapsing it to one word before it
                // reaches a prompt loses the half a director spent time on.
                moves: JSON.parse(row.moves_json || '[]'),
                path: JSON.parse(row.path_json || '[]'),
            };
        }
    } catch (_) { previs = null; }

    /**
     * The plates this shot generates with — gathered HERE, where the reading
     * happens, not in the payload builder.
     *
     * This is the gap that made the shared payload path a partial one. The
     * board routes gathered tagged, inlined plates and the orchestrator
     * gathered nothing, so a pipeline run generated keyframes with no
     * conditioning at all while the board conditioned correctly — the same
     * shape of divergence `regenerateShot` already shipped once. Every
     * reference feature added since (character and location plates, prop
     * plates, mood-board style images, the scene anchor) reached three paths
     * out of four.
     *
     * `tagged` travels with them because they are two different questions: a
     * provider may take pictures and still be unable to read `@maya` from the
     * prompt, and emitting the tag there replaces the appearance with a token
     * meaning nothing.
     */
    let references = [], tagged = false, anchorTag = null, anchorAttached = false, anchorCovers = [];
    try {
        const { shotReferencesFor, matchCharacters, matchLocation, matchProps } =
            require('./shot-references');
        const locations = db.prepare('SELECT * FROM film_locations WHERE project_id = ?').all(scene.project_id);
        const anchor = require('./shot-anchor').activeAnchorFor(db, shotId);
        const gathered = shotReferencesFor(db, {
            projectId: scene.project_id,
            providerConfig: providerConfigOf(project),
            characters: matchCharacters(sceneCard.characters, characters),
            location: matchLocation(scene.location, locations),
            props: matchProps(sceneCard, props),
            anchor: anchor.shot ? anchor : null,
        });
        anchorCovers = anchor.shot
            ? [...require('./shot-anchor').subjectsCoveredBy(db, anchor)] : [];
        references = gathered.references;
        tagged = gathered.tagged;
        anchorTag = gathered.anchorTag;
        anchorAttached = gathered.anchorAttached;
    } catch (_) {
        // A project with no plates, or a provider that cannot be resolved,
        // generates exactly as it did before rather than failing to build a
        // payload at all.
        references = []; tagged = false; anchorTag = null; anchorAttached = false; anchorCovers = [];
    }

    return {
        shot, scene, project, sceneCard, characters, location, voiceProfiles, props,
        keyframeAsset, videoAsset, audioAsset, musicCue, initImage,
        consistency: consistencyContext,
        previs,
        references, tagged, anchorTag, anchorAttached, anchorCovers,
        annotations,
        // The project's standing answer to PAR-026. A route may override it per
        // request; nothing else may, because a default that turns itself on is
        // the failure this column exists to prevent.
        useAnnotations: !!(project && project.annotation_feedback),
        overrides: {},
    };
}

/**
 * Parsed per-project provider_config, for resolve()/resolveGenerator().
 *
 * Delegates to lib/provider-config.js, which also tags the object with the
 * project id — that is what lets resolve() attribute what a call spends
 * without any of its callers changing shape.
 */
function providerConfigOf(project) {
    return require('./provider-config').providerConfigOf(project);
}

/**
 * Persist a provider result for a capability under the conventional directory.
 * Thin wrapper so node handlers (Phase 2) do not each re-derive the mapping.
 */
async function persistCapabilityResult(capability, result, ctx, filename) {
    const { persistProviderMedia } = require('./provider-media');
    const SUBDIR = {
        image: 'storyboards', video: 'video', voice: 'audio', lipsync: 'video',
        music: 'music', sfx: 'music', ambient: 'music', post: 'video',
    };
    const SERVE = {
        image: 'images', video: 'videos', voice: 'audio', lipsync: 'videos',
        music: 'music', sfx: 'music', ambient: 'music', post: 'videos',
    };
    const subdir = SUBDIR[capability];
    if (!subdir) throw new Error(`no storage mapping for capability '${capability}'`);

    const projectId = projectIdOf(ctx || {});
    const path = await persistProviderMedia(projectId, subdir, filename, result && result.data, {
        serveDir: SERVE[capability],
    });
    return { path, subdir };
}

module.exports = {
    imagePromptLimit,
    dimensionsForAspect,
    IMAGE_DEFAULTS,
    CAPABILITY_BUILDERS,
    preconditionError,
    buildCapabilityPayload,
    loadShotContext,
    persistCapabilityResult,
    imageRequestPayload,
    providerConfigOf,
    tagSpend,
    IMAGE_DEFAULTS,
    dimensionsForAspect,
    DEFAULT_POST_JOB_TYPE,
};
