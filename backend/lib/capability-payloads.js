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

const { buildStoryboardPrompt, rankContributions, trimToAllowance } = require('./storyboard-prompt');
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
// The strictest ceiling any image adapter here declares (OpenAI's 1536x1024).
// Used only when the provider is unknown at build time.
const DEFAULT_MAX_IMAGE_PIXELS = 1536 * 1024;

/*
 * NO DEFAULT MODEL, and this one mattered more than it looks.
 *
 * It named a model none of the image providers wired here offers, so every
 * provider fell through to its own default — on Meshy that is nano-banana-pro
 * at 9 credits, the most expensive model it sells. Worse, it made the quality
 * tier INERT on the main board path: withTierModel returns early when the
 * payload already names a model, so Draft, Standard and Precision all generated
 * on the same expensive model while the picker showed three choices.
 *
 * The provider names its own model; the tier names one when a project has
 * chosen a quality. Nothing is guessed here.
 */
const IMAGE_DEFAULTS = { width: 1024, height: 1024, steps: 30, guidance_scale: 7.5 };

const LIPSYNC_DEFAULTS = { model: 'wav2lip', quality: 'high' };

// Which post sub-type the single orchestrated `post` step runs. Composite is the
// existing full pipeline, so an unconfigured run keeps doing what it did.
const DEFAULT_POST_JOB_TYPE = 'composite';

/**
 * Put a locked contract in the prompt once, at the priority this shot gives it.
 *
 * Real consistency contracts are commonly exact copies of the registry visual
 * brief. Passing both unchanged made every locked subject appear twice: once
 * in buildStoryboardPrompt's appearance block and again in the consistency
 * appendix. Ranking the appendix therefore changed a synthetic fixture while
 * the full 1,936-character sedan still survived through the base prompt.
 *
 * Exact matches are projected into the registry copy after ranking/capping and
 * removed only from the appendix used for this build. The original consistency
 * context is left untouched so the preview can attribute how much of each
 * director contract actually survived in the final prompt.
 */
function projectLockedContracts(ctx, shot) {
    const cc = ctx && ctx.consistency;
    const items = cc && Array.isArray(cc.prompt_addition_items)
        ? cc.prompt_addition_items : [];
    if (!items.length) return null;

    const ranked = rankContributions(items.map(item => ({
        subject: item.subject_name,
        kind: item.profile_type,
        chars: String(item.text || '').length,
        item,
    })), shot);
    const byName = new Map();
    for (const rankedItem of ranked) {
        const item = rankedItem.item;
        const original = String(item && item.text || '');
        const text = rankedItem.chars < original.length
            ? trimToAllowance(original, rankedItem.chars) : original;
        byName.set(String(item && item.subject_name || '').trim().toUpperCase(), { item, text });
    }

    const consumed = new Set();
    const characters = (ctx.characters || []).map(character => {
        const found = byName.get(String(character && character.name || '').trim().toUpperCase());
        if (!found || String(character.appearance_prompt || '') !== String(found.item.text || '')) return character;
        consumed.add(found.item);
        return { ...character, appearance_prompt: found.text };
    });
    const props = (ctx.props || []).map(prop => {
        const found = byName.get(String(prop && prop.name || '').trim().toUpperCase());
        if (!found || String(prop.visual_prompt || '') !== String(found.item.text || '')) return prop;
        consumed.add(found.item);
        return { ...prop, visual_prompt: found.text };
    });
    let location = ctx.location || null;
    if (location) {
        const found = byName.get(String(location.name || '').trim().toUpperCase());
        const field = String(location.visual_prompt || '') === String(found && found.item.text || '')
            ? 'visual_prompt'
            : String(location.description || '') === String(found && found.item.text || '') ? 'description' : null;
        if (found && field) {
            consumed.add(found.item);
            location = { ...location, [field]: found.text };
        }
    }

    const remaining = items.filter(item => !consumed.has(item));
    return {
        characters,
        props,
        location,
        consistency: { ...cc, prompt_addition_items: remaining,
            prompt_additions: remaining.map(item => item.text) },
    };
}

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
    const ratio = require('./project-presets').aspectValue(aspect);
    if (!ratio) return { width: fallbackW, height: fallbackH };

    const targetPixels = fallbackW * fallbackH;
    const round8 = n => Math.max(256, Math.round(n / 8) * 8);
    return {
        width: round8(Math.sqrt(targetPixels * ratio)),
        height: round8(Math.sqrt(targetPixels / ratio)),
    };
}

/**
 * THE PROJECT'S DELIVERY SIZE, CLAMPED TO WHAT A PROVIDER CAN MAKE.
 *
 * The board frame was sized from a fixed 1024x1024 budget, so a project set to
 * 4K and a project set to 720p boarded at exactly the same size — the delivery
 * size a director chose reached the footage and nothing else.
 *
 * The other half is a ceiling that must not be papered over: no generator here
 * produces 4K. Asking for more than a provider allows is a rejection that costs
 * a generation and returns nothing, so the request is clamped — preserving the
 * SHAPE, since a clamp that changes the aspect would put the board and the
 * footage back out of step — and the clamp is reported. "I set the project to
 * 4K" and "my boards are 4K" are different claims, and a director who is not
 * told will believe the second because they did the first.
 *
 * The route to an actual 4K deliverable is the upscale in post, not a bigger
 * ask here.
 */
function imageBudget(aspect, resolution, maxPixels) {
    const res = String(resolution || '').match(/^\s*(\d+)\s*x\s*(\d+)\s*$/i);
    const base = res
        ? { width: Number(res[1]), height: Number(res[2]) }
        : { width: IMAGE_DEFAULTS.width, height: IMAGE_DEFAULTS.height };

    const shaped = dimensionsForAspect(aspect, base.width, base.height);
    /*
     * An unknown provider gets the STRICT default, not none.
     *
     * Over-asking is a rejection at the provider that costs a generation and
     * returns nothing; under-asking is a smaller picture, generated here, where
     * the clamp can be reported. The same asymmetry that decides promptLimit
     * and maxReferenceImages when an adapter declares nothing.
     */
    const cap = Number(maxPixels) > 0 ? Number(maxPixels) : DEFAULT_MAX_IMAGE_PIXELS;
    const asked = shaped.width * shaped.height;
    if (!cap || asked <= cap) return { ...shaped, clamped: false };

    // Scale down on the diagonal so the shape survives exactly.
    const k = Math.sqrt(cap / asked);
    const round8 = n => Math.max(256, Math.round((n * k) / 8) * 8);
    return {
        width: round8(shaped.width), height: round8(shaped.height),
        clamped: true, asked_width: shaped.width, asked_height: shaped.height,
    };
}

function imageRequestPayload(fields) {
    const f = fields || {};
    // An explicit width/height still wins; otherwise follow the project's frame.
    const dims = (f.width && f.height)
        ? { width: f.width, height: f.height }
        : imageBudget(f.aspect_ratio, f.target_resolution, f.max_image_pixels);
    if (dims.clamped && f.__onClamp) f.__onClamp(dims);

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

/**
 * The pictures a shot already has, restated as video reference ROLES.
 *
 * Deliberately reuses what the image path gathered (`ctx.references`), rather
 * than gathering again: two gatherers is how two surfaces come to disagree
 * about who is in a shot, which this codebase has paid for more than once.
 */
function referencesToRoles(ctx) {
    const KIND_TO_ROLE = { anchor: 'keyframe', character: 'character', location: 'location', prop: 'prop', style: 'style' };
    const out = [];
    if (ctx && ctx.initImage) out.push({ assetId: 'keyframe', role: 'keyframe', sourceType: 'image', uri: ctx.initImage });
    for (const ref of (ctx && ctx.references) || []) {
        const role = KIND_TO_ROLE[ref.kind];
        if (!role || role === 'keyframe') continue;      // the board is the init_image, not a reference
        out.push({
            assetId: ref.id || ref.assetId || ref.tag || role,
            role, subject: ref.name || ref.subject || undefined,
            sourceType: 'image', uri: ref.uri, priority: ref.priority || 0,
        });
    }
    return out;
}

const CAPABILITY_BUILDERS = {
    image(ctx) {
        requireCtx(ctx, ['sceneCard', 'project'], 'image');
        const overrides = ctx.overrides || {};
        const cc = ctx.consistency || null;
        const promptLimit = Number(ctx.imagePromptLimit) > 0
            ? Number(ctx.imagePromptLimit)
            : imagePromptLimit(ctx.project);
        const shotPriority = { framingSubject: (ctx.sceneCard && ctx.sceneCard.framing_subject) || null,
            card: ctx.sceneCard || {} };
        const projected = projectLockedContracts(ctx, shotPriority);
        const promptCharacters = projected ? projected.characters : ctx.characters;
        const promptProps = projected ? projected.props : ctx.props;
        const promptLocation = projected ? projected.location : ctx.location;
        const promptConsistency = projected ? projected.consistency : cc;

        // Blocking shapes the keyframe, not only the clip. Passing it here is
        // what makes the frame a director approves the frame they staged.
        const base = buildStoryboardPrompt(ctx.sceneCard, promptCharacters, promptLocation,
            ctx.project.style_preset, {
                // Which job the director is doing. Defaults to `action`, so a
                // caller that says nothing gets exactly what it got before.
                directionMode: ctx.directionMode || 'action',
                anchorCovers: ctx.anchorAttached ? (ctx.anchorCovers || []) : [],
                previs: ctx.previs || undefined,
                // Resolved here rather than passed in, so the orchestrator and
                // the per-domain route cannot disagree about how much prompt a
                // provider accepts — the same reason this file exists at all.
                maxPromptChars: promptLimit,
                // The production's own optics, for shots nobody has blocked.
                filmOptics: filmOpticsFor(ctx.project),
                // Declared dimensions, so the prompt can say how big things are
                // relative to the frame and to each other.
                props: promptProps || [],
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
            /*
             * A SHOT's own ratio outranks the project's.
             *
             * A spot is not shot entirely vertical: it has a handful of shots
             * that carry the product and the CTA, and those are generated at
             * 9:16 because a crop to it keeps 32% of the width. Empty inherits
             * the project's, which is what every existing shot does.
             *
             * The board and the footage must agree about this or the keyframe a
             * clip is generated FROM is a different shape than the clip — so
             * the same field feeds both, and `spec-consumption` holds them to it.
             */
            aspect_ratio: (ctx.sceneCard && ctx.sceneCard.aspect_ratio) || ctx.project.aspect_ratio,
            // The delivery size the director set, and the ceiling of whoever is
            // generating. A board sized from a constant made a 4K project and a
            // 720p project board identically.
            target_resolution: ctx.project.target_resolution,
            max_image_pixels: ctx.maxImagePixels || null,
            __onClamp: d => {
                ctx.__clamp = {
                    asked: `${d.asked_width}x${d.asked_height}`,
                    generating: `${d.width}x${d.height}`,
                    why: 'the image provider cannot produce a picture that large; the shape is '
                        + 'unchanged. Upscale in post for a larger deliverable.',
                };
            },
            // The pictures themselves. Without this the prompt above could emit
            // @maya with nothing for it to point at, which is strictly worse
            // than having used prose.
            reference_images: ctx.references,
        });

        // The ceiling goes WITH the additions, because they are part of the
        // prompt the provider receives — enforcing it before they are appended
        // measures the wrong string.
        ctx.__budget = base.budget || null;
        return cc
            ? applyConsistencyToImagePayload(payload, promptConsistency, {
                maxPromptChars: promptLimit,
                // Subjects standing in the attached frame keep their name and
                // lose their paragraph — but only when the frame really is in
                // this payload, since shortening against a picture that did not
                // travel is the failure the contract shortening was reverted for.
                anchorCovers: ctx.anchorAttached ? (ctx.anchorCovers || []) : [],
                // What this shot is OF, so priority can govern allocation once
                // the ceiling stops binding. Without it the longest contract
                // wins and a parked car outweighs the protagonist.
                shot: shotPriority,
            })
            : payload;
    },

    video(ctx) {
        requireCtx(ctx, ['sceneCard', 'project'], 'video');
        const overrides = ctx.overrides || {};
        const cc = ctx.consistency || {};

        /*
         * The reference package, chosen by the MODEL's own contract.
         *
         * This is not a return of the plates that were removed. That removal
         * stands and is why the default here is keyframe-only: on Gen-4.5 the
         * keyframe IS the init_image and was already generated from the plates,
         * so re-sending them asks the model which picture is the truth.
         *
         * What changed is that H3 and Seedance 2.5 can be told what each
         * picture is FOR. A named reference is a different thing from a pile of
         * them — recompose proved that — and on H3 nine of them cost 18
         * credits, which is why the package is worth assembling at all.
         *
         * An unknown model resolves to the keyframe-only contract, so every
         * existing shot builds byte-identically.
         */
        const videoRef = require('./video-reference');
        const contract = videoRef.contractFor(overrides.model);
        const offered = referencesToRoles(ctx);
        const picked = videoRef.selectReferences(offered, contract);

        const built = buildVideoPayload(ctx.sceneCard, ctx.characters, ctx.location, ctx.project.style_preset, {
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
            filmOptics: filmOpticsFor(ctx.project),
            props: ctx.props || [],
            // The direction drawn on the board. A still can only show a state;
            // an arrow is about what happens next, which is exactly what a clip
            // has room for and a frame does not.
            annotations: ctx.useAnnotations ? (ctx.annotations || []) : undefined,
            // The delivery frame rate and size, so generation targets what the
            // film is actually delivered at rather than a constant.
            project: ctx.project,
        });

        /*
         * Attached AFTER the build, not passed into it: buildVideoPayload
         * assembles its payload from the fields it knows about and silently
         * drops anything else, so passing the package in as an option left it
         * reaching nothing while every source check said it was wired.
         *
         * Only when the model takes more than its keyframe, so a Gen-4.5
         * payload gains no new field at all and stays byte-identical.
         */
        if (picked.selected.length > 1) built.video_references = picked.selected;
        if (picked.dropped.length) built.references_dropped = picked.dropped;
        return built;
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

            // The scene's own direction, so the orchestrator and the flow
            // canvas ask for the same performance the per-domain route does.
            const payload = buildVoicePayload(line, voiceProfile, character, {
                scene: { delivery: (ctx.scene && ctx.scene.delivery_direction) || '' },
            });
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
        // The scene's own ambient direction and the location's sound notes —
        // the orchestrator and the flow canvas must describe the bed the same
        // way the per-domain route does, which is the whole point of this file.
        return buildAmbientPrompt(ctx.scene, ctx.location, ctx.ambient || {});
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
 * Build the complete image payload for the adapter that will receive it.
 *
 * This deliberately starts from structured shot context on every call. A
 * finished prompt cannot be safely adapted to a smaller provider: its
 * contributor boundaries and priority information are already gone. Providers
 * that fold the negative into the positive also need that text reserved inside
 * their declared prompt ceiling before either prompt assembly or consistency
 * contracts are budgeted.
 */
function buildImagePayloadForAdapter(ctx, adapter) {
    const declared = Number(adapter && adapter.promptLimit) || imagePromptLimit(ctx && ctx.project);
    // The same route the prompt ceiling takes: the adapter's own limit, applied
    // where the payload is built for it, so the frame is as large as this
    // provider can actually make and no larger.
    const pixels = Number(adapter && adapter.maxImagePixels) || null;
    const firstCtx = { ...(ctx || {}), imagePromptLimit: declared, maxImagePixels: pixels };
    const first = CAPABILITY_BUILDERS.image(firstCtx);
    const firstPayload = Array.isArray(first) ? first[0] : first;
    const negative = String((firstPayload && firstPayload.negative_prompt) || '').trim();
    const reserve = adapter && adapter.supportsNegativePrompt === 'folded' && negative
        ? negative.length + '\n\nAvoid: '.length
        : 0;
    const available = declared ? Math.max(1, declared - reserve) : declared;
    if (!declared || available === declared) return withTierModel(firstPayload, ctx, adapter);

    const rebuiltCtx = { ...(ctx || {}), imagePromptLimit: available, maxImagePixels: pixels };
    const rebuilt = CAPABILITY_BUILDERS.image(rebuiltCtx);
    return withTierModel(Array.isArray(rebuilt) ? rebuilt[0] : rebuilt, ctx, adapter);
}

/**
 * Name the MODEL the chosen quality tier wants from this provider.
 *
 * Resolving a tier to a provider is only half of it. Standard and Precision
 * both land on Google — the difference between them IS the model, so a tier
 * that reached the provider and not the model would make the two settings
 * generate identically while the UI showed a choice. That is the failure this
 * whole feature is meant to avoid, one level further down than the config.
 *
 * An explicit `image_model` still wins: the Advanced selector exists so a
 * director who has learned that one model handles their subject is not
 * overruled by a table.
 */
function withTierModel(payload, ctx, adapter) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.model) return payload;                       // already stated
    const base = (ctx && ctx.project && providerConfigOf(ctx.project)) || {};
    // A per-generation choice outranks the project's standing tier: the
    // director is looking at this frame, not at the settings page.
    const cfg = (ctx && ctx.tierOverride) ? { ...base, ...ctx.tierOverride } : base;
    if (cfg.image_model) {
        /*
         * Checked HERE too, not only where it is saved.
         *
         * The settings route refuses a model the provider does not offer, but
         * a per-generation override reaches this function without passing
         * through it — so an unknown name went straight to the provider, which
         * falls back to its own default rather than refusing. On Meshy that
         * default is the most expensive model it sells, so the mistake is
         * silent and costs three times what was asked for.
         *
         * An adapter that declares no model list cannot be checked; its pin is
         * passed through as before.
         */
        const known = adapter.models ? Object.keys(adapter.models) : null;
        if (!known || known.includes(cfg.image_model)) {
            payload.model = cfg.image_model;
            Object.defineProperty(payload, '__model_for', {
                value: adapter.id, enumerable: false, configurable: true, writable: true,
            });
            return payload;
        }
        // Unknown: fall through to the tier, which names a model this provider
        // really has, rather than letting the provider pick its dearest.
    }
    if (!adapter || !adapter.id) return payload;
    try {
        const { resolveTier } = require('./quality-tiers');
        // Defaults when the project has said nothing, so a frame is never
        // generated on whatever model a provider happens to prefer — Meshy's
        // own default is nano-banana-pro at three times the credits of
        // nano-banana-2, which is a real bill nobody chose.
        const chosen = resolveTier(cfg.image_quality || undefined, cfg, ctx && ctx.tierRequest);
        // Only when the tier actually landed on the adapter being built for:
        // naming Google's model on a request going to OpenAI is a rejected call.
        if (chosen && chosen.provider === adapter.id && chosen.model) {
            payload.model = chosen.model;
            /*
             * Which adapter this model was chosen FOR, stamped non-enumerably
             * so it never serialises into a request body. The fallback chain
             * walks past a provider that declines, so the adapter changes while
             * the payload does not — and most adapters guard against a foreign
             * model name, but the local gateway passes `p.model` straight
             * through by design. Marking the owner lets the chain strip it
             * without every adapter having to defend itself.
             */
            Object.defineProperty(payload, '__model_for', {
                value: adapter.id, enumerable: false, configurable: true, writable: true,
            });
        }
    } catch (_) { /* a broken tier must never block a generation */ }
    return payload;
}

/**
 * Build the provider payload for a capability.
 *
 * @param {string} capability
 * @param {object} ctx - { project, scene, shot, sceneCard, characters, location,
 *                         voiceProfiles, videoAsset, audioAsset, keyframeAsset,
 *                         musicCue, ambient, initImage, consistency, overrides }
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
    // The image builder reports how the prompt budget was spent; captured here
    // so `shot_prompt` can show it without rebuilding the prompt a second time
    // and risking a different answer.
    context.__budget = null;
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
            budget: context.__budget || [],
            cardinality: Array.isArray(payload) ? 'many' : 'one',
            count: Array.isArray(payload) ? payload.length : 1,
            project_id: projectIdOf(context),
            scene_id: context.scene ? context.scene.id : null,
            shot_id: context.shot ? context.shot.id : null,
            /*
             * If the delivery size was larger than the provider can produce,
             * say so. Silently generating a smaller picture would let a
             * director believe their 4K project is being boarded at 4K, which
             * they would only discover in the cut.
             */
            ...(context.__clamp ? { resolution_clamped: context.__clamp } : {}),
        },
    };
}

/**
 * Load everything a shot-scoped builder needs, in one place.
 *
 * The DB is required here rather than at module scope so that building a
 * payload from an already-loaded context needs no database at all.
 */
function loadShotContext(shotId, opts) {
    const fs = require('fs');
    const { db } = require('../db/database');
    const { getFilePath } = storage();

    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return null;

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return null;

    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { sceneCard = {}; }

    /*
     * A SHOT's own ratio, from its column rather than its card.
     *
     * It is a column because it is a production decision about how this shot is
     * SHOT — a vertical hero or product shot is generated at 9:16 because a
     * crop to it keeps 32% of the width — rather than something the writing
     * says. Carried onto the card so the image builder and the video builder
     * read it from the same place: two answers to "what shape is this shot"
     * gives a keyframe of one shape and a clip of another, which is the exact
     * defect the board/footage reconciliation was written to end.
     *
     * Empty inherits the project's, which is what every existing shot does.
     */
    if (shot.aspect_ratio) sceneCard.aspect_ratio = shot.aspect_ratio;

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

    /*
     * The scene's ambient direction, if anyone has written one.
     *
     * An ambient cue is an ordinary film_music_cues row with cue_type
     * 'ambient'. Read here so the orchestrator and the flow canvas describe the
     * bed the same way the per-domain route does — the whole reason this file
     * exists.
     */
    const ambientCue = db.prepare(
        "SELECT * FROM film_music_cues WHERE scene_id = ? AND cue_type = 'ambient' ORDER BY start_ms LIMIT 1"
    ).get(scene.id);
    const ambient = {
        direction: String((ambientCue && ambientCue.description) || '').trim(),
        negative_prompt: String((ambientCue && ambientCue.negative_prompt) || '').trim(),
    };

    /*
     * The keyframe, as a DATA URI.
     *
     * This produced a bare base64 string, which is not a URL, not a data URI
     * and not a provider handle — so `promptImage` was rejected as invalid
     * input and EVERY second of footage in this project was blocked by it. The
     * reference plates one file over have always been correct
     * (`data:${mime};base64,…` in lib/reference-images.js); the keyframe, which
     * every image-to-video call depends on, never was.
     *
     * Built HERE rather than at a call site: the per-domain route, the
     * orchestrator and the flow canvas all read ctx.initImage, and patching one
     * of them would leave the other two sending a bare blob.
     */
    let initImage = null;
    if (keyframeAsset && keyframeAsset.file_name) {
        try {
            const imgPath = getFilePath(scene.project_id, 'storyboards', keyframeAsset.file_name);
            if (fs.existsSync(imgPath)) {
                const mime = /\.jpe?g$/i.test(imgPath) ? 'image/jpeg'
                    : /\.webp$/i.test(imgPath) ? 'image/webp' : 'image/png';
                initImage = `data:${mime};base64,${fs.readFileSync(imgPath).toString('base64')}`;
            }
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
    let previsApplication = null;
    try {
        const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
        if (row) {
            const { applicationFingerprints } = require('./decision-contract');
            const applicationNow = applicationFingerprints(row, sceneCard, {
                knownNames: [...characters, ...props].map(subject => subject.name),
            });
            const stageMoved = applicationNow.stage !== row.applied_fingerprint;
            const cardMoved = applicationNow.card !== row.applied_card_fingerprint;
            const applicationState = !row.applied_fingerprint || !row.applied_card_fingerprint ? 'staged'
                : stageMoved && cardMoved ? 'conflict'
                    : stageMoved ? 'staged' : cardMoved ? 'card_ahead' : 'applied';
            previs = {
                camera: JSON.parse(row.camera_json || '{}'),
                director: JSON.parse(row.director_json || '{}'),
                subject: JSON.parse(row.subject_json || '{}'),
                stage: JSON.parse(row.stage_json || '{}'),
                rig: row.rig,
                movement: row.movement,
                application: {
                    state: applicationState,
                    applied: applicationState === 'applied',
                    staged: applicationState === 'staged',
                    card_ahead: applicationState === 'card_ahead',
                    conflict: applicationState === 'conflict',
                    applied_at: row.applied_at || null,
                },
                // The legs, not just the single movement column. A compound
                // move is what was blocked; collapsing it to one word before it
                // reaches a prompt loses the half a director spent time on.
                moves: JSON.parse(row.moves_json || '[]'),
                cameraKeys: JSON.parse(row.camera_keys_json || '[]'),
                // What is ON the stage, not just where the camera is. Without
                // this the loader carried the whole camera and dropped the
                // blocking, so a scene arranged in 3D reached generation as
                // silence — the exact gap staging exists to close, one layer
                // below where it was closed.
                subjects: JSON.parse(row.subjects_json || '[]'),
                path: JSON.parse(row.path_json || '[]'),
            };
            previsApplication = previs.application;
            // Durable generation consumes only decisions the director applied.
            // Previs's free what-if previews opt into staged blocking explicitly.
            const mode = (opts && opts.previsMode) || 'applied';
            if (mode === 'none' || (mode === 'applied' && !previs.application.applied)) previs = null;
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
        /*
         * Plates that must travel even though the anchor names their subject.
         * An anchor covers where a subject STANDS; it covers who they ARE only
         * if it shows them, and a wide with someone's back to camera shows no
         * face at all. A close-up built on that has nothing to go on.
         */
        const keepPlates = [
            ...(opts && Array.isArray(opts.keepPlates) ? opts.keepPlates : []),
            ...require('./shot-anchor').platesForcedBy(sceneCard),
        ];
        const gathered = shotReferencesFor(db, {
            projectId: scene.project_id,
            providerConfig: providerConfigOf(project),
            characters: matchCharacters(sceneCard.characters, characters),
            location: matchLocation(scene.location, locations),
            props: matchProps(sceneCard, props),
            anchor: anchor.shot ? anchor : null,
            keepPlates,
            // Which view of the location this shot is pointed at.
            locationView: sceneCard.location_view || '',
        });
        anchorCovers = anchor.shot
            ? [...require('./shot-anchor').subjectsCoveredBy(db, anchor, keepPlates)] : [];
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
        keyframeAsset, videoAsset, audioAsset, musicCue, ambient, initImage,
        consistency: consistencyContext,
        previs,
        // State is useful for disclosure even when the durable payload rightly
        // excludes the unapplied blocking itself.
        previsApplication,
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
    // Where this capability's output lives, and where it is served from — read
    // from the one registry rather than restated here. This was a third copy of
    // a fact routes/pipeline.js held twice.
    const { SUBDIR, SERVE_DIR } = require('./media-kinds');
    const subdir = SUBDIR[capability];
    if (!subdir) throw new Error(`no storage mapping for capability '${capability}'`);

    const projectId = projectIdOf(ctx || {});
    const path = await persistProviderMedia(projectId, subdir, filename, result && result.data, {
        serveDir: SERVE_DIR[capability],
    });
    return { path, subdir };
}

module.exports = {
    imageBudget,
    imagePromptLimit,
    buildImagePayloadForAdapter,
    withTierModel,
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
