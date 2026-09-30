/**
 * Seedance 2.5 (ByteDance), reached through MuAPI's REST surface.
 *
 *   POST https://api.muapi.ai/api/v1/seedance-2.5-{workflow}-{resolution}
 *   header: x-api-key
 *
 * THE MODEL IS IN THE ROUTE NAME. There is no `model` field to set, which means
 * a workflow chosen wrongly is a different endpoint rather than a parameter the
 * provider quietly ignores — so the choice is made once, here, from what the
 * payload actually carries.
 *
 * Why this sits beside Runway rather than replacing it:
 *
 *   Runway's gen4.5 takes TWO keyframes, first and last. That has been the hard
 *   ceiling on "generate this specific sequence from these pictures" — the
 *   request that keeps coming back is a shot conditioned on a frame, a pose
 *   reference and the established geography at once, and two slots cannot hold
 *   it. Seedance's OMNI REFERENCE workflow takes up to THIRTY images, ten videos
 *   and ten audio clips. That is a different capability, not a cheaper one.
 *
 *   It is also 4K-capable, at $1.70/s — which is real money per second and the
 *   reason the resolution is derived from the project's delivery setting rather
 *   than defaulted upward.
 *
 * Asynchronous: POST returns a request_id, and the finished video is polled from
 * /predictions/{id}/result. The adapter returns the URL rather than the bytes,
 * because a video is large and every consumer here already downloads by URL —
 * unlike BFL, whose result link expires in ten minutes.
 */

const { getCredential } = require('./credentials');

const BASE_URL = process.env.SEEDANCE_BASE_URL || 'https://api.muapi.ai/api/v1';

/* Documented resolutions, and what a second of each costs. */
const RESOLUTIONS = Object.freeze({
    '480p': { suffix: '-480p', longEdge: 854, usdPerSecond: 0.17 },
    '720p': { suffix: '', longEdge: 1280, usdPerSecond: 0.34 },   // the unsuffixed default
    '1080p': { suffix: '-1080p', longEdge: 1920, usdPerSecond: 0.85 },
    '4k': { suffix: '-4k', longEdge: 3840, usdPerSecond: 1.70 },
});

const WORKFLOWS = Object.freeze({
    'text-to-video': { images: 0 },
    'image-to-video': { images: 1 },
    'first-last-frame': { images: 2 },
    'omni-reference': { images: 30 },
    'video-edit': { images: 0 },
    'video-extend': { images: 0 },
});

/** What Seedance accepts; anything else is a rejected request. */
const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'];
const MIN_DURATION = 4, MAX_DURATION = 30;
const MAX_KEYFRAMES = 30;

const POLL_INTERVAL_MS = Number(process.env.SEEDANCE_POLL_INTERVAL_MS || 4000);
const POLL_TIMEOUT_MS = Number(process.env.SEEDANCE_POLL_TIMEOUT_MS || 900000);

/**
 * The tier this payload resolves to, AND what it was asked for.
 *
 * Separated from `resolutionFor` because snapping has to be REPORTABLE. This
 * adapter documents four tiers — 480p, 720p, 1080p, 4K — and nothing between
 * them. A project set to 2K (2560x1440) is a legitimate ask that this provider
 * cannot serve, and the rule below never rounds UP, so it quietly delivers
 * 1080p. That is the right call on the bill and the wrong one in silence: a
 * director who asked for 2K and was shown no objection has every reason to
 * believe 2K is what rendered.
 */
function resolutionDecision(payload) {
    const p = payload || {};
    const resolution = resolutionFor(p);
    const raster = String(p.target_resolution || '');
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(raster);
    const askedLongEdge = m ? Math.max(Number(m[1]), Number(m[2])) : 0;
    const explicit = String(p.resolution || p.quality || '').toLowerCase();
    const served = RESOLUTIONS[resolution].longEdge;
    return {
        resolution,
        asked: explicit && RESOLUTIONS[explicit] ? explicit : (askedLongEdge ? raster : null),
        // Only a RASTER can be snapped. An explicit tier name is either one of
        // the four or it was ignored, and both are already visible.
        snapped: !!(askedLongEdge && !explicit && askedLongEdge !== served),
        asked_long_edge: askedLongEdge || null,
        served_long_edge: served,
    };
}

/**
 * THE FRAME THIS WILL ACTUALLY COME BACK AS.
 *
 * `width`/`height` on the payload are decoration here: the model is the route
 * name, and the only size control is which tier that route names. Seedance then
 * builds its own frame by holding the TIER'S PIXEL BUDGET and reshaping it to
 * the aspect it is working in -- so a 1080p request on a 2.39:1 keyframe comes
 * back 2232x934, not the 1920x804 this engine composed.
 *
 * Neither number is wrong; they answer different questions. What was wrong was
 * reporting only ours, so every preview quoted a frame the vendor was never
 * going to produce, and the mismatch was invisible until someone measured a
 * delivered file. lib/video-prompt.js has the same arithmetic written down and
 * rejected for its own use -- "area-preserving gives 2226x932 for scope" -- and
 * nothing ever reconciled the two.
 */
function predictedFrame(payload) {
    const p = payload || {};
    const tier = resolutionFor(p);
    const longEdge = RESOLUTIONS[tier].longEdge;
    // The tier is named for a 16:9 frame, and its BUDGET is what survives a
    // reshape: 1080p is 1920x1080 worth of pixels, whatever shape they end up.
    const budget = longEdge * (longEdge * 9 / 16);

    // The aspect it will actually work in. An explicit ratio wins; otherwise it
    // follows the picture it was handed, which is what "Auto" does.
    const declared = aspectFor(p);
    let ratio = null;
    const m = /^(\d+):(\d+)$/.exec(String(declared || ''));
    if (m) ratio = Number(m[1]) / Number(m[2]);
    if (Number(p.width) > 0 && Number(p.height) > 0) ratio = Number(p.width) / Number(p.height);
    if (!Number.isFinite(ratio) || ratio <= 0) ratio = 16 / 9;

    const even = n => Math.max(2, Math.round(n / 2) * 2);
    return {
        width: even(Math.sqrt(budget * ratio)),
        height: even(Math.sqrt(budget / ratio)),
        tier,
        why: `Seedance sizes by TIER, not by width/height: ${tier} is ${longEdge}x${Math.round(longEdge * 9 / 16)} `
            + `worth of pixels, reshaped to the aspect it is working in (${ratio.toFixed(3)}:1).`,
    };
}

/** The delivery resolution the project asked for, snapped to what exists. */
function resolutionFor(payload) {
    const explicit = String(payload.resolution || payload.quality || '').toLowerCase();
    if (RESOLUTIONS[explicit]) return explicit;
    /*
     * A MODEL CHOSEN ON THE DIALOG IS A RESOLUTION CHOSEN.
     *
     * The dialog has always been able to send `model`, and this adapter read
     * only `resolution` -- so picking "Seedance 2.5 - 1080p" changed the label
     * on the confirmation and nothing about the request. Read after the
     * explicit field so a route that genuinely knows the tier still wins.
     */
    const asked = String(payload.model || payload.video_model || '');
    const byModel = VIDEO_MODELS[asked] || POST_MODELS[asked];
    if (byModel) return byModel.resolution;
    const raster = String(payload.target_resolution || '');
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(raster);
    const longEdge = m ? Math.max(Number(m[1]), Number(m[2])) : 0;
    if (!longEdge) return '720p';
    // Never round UP: 4K is five times the price of 1080p per second, and a
    // resolution nobody asked for is a bill nobody expected.
    if (longEdge >= 3840) return '4k';
    if (longEdge >= 1920) return '1080p';
    if (longEdge >= 1280) return '720p';
    return '480p';
}

function aspectFor(payload) {
    const declared = String(payload.aspect_ratio || '').trim();
    if (ASPECTS.includes(declared)) return declared;
    // Chosen on the dialog: the frame follows the picture it is handed.
    if (declared === 'adaptive') return 'adaptive';
    const m = /^(\d+)\s*[x:]\s*(\d+)$/.exec(String(payload.target_resolution || ''));
    if (!m) return '16:9';
    const r = Number(m[1]) / Number(m[2]);
    return ASPECTS.reduce((best, a) => {
        const [w, h] = a.split(':').map(Number);
        return Math.abs(w / h - r) < Math.abs(
            Number(best.split(':')[0]) / Number(best.split(':')[1]) - r) ? a : best;
    }, '16:9');
}

/** Every picture the payload carries, in rank order, as URLs or data URIs. */
function collectImages(p) {
    const out = [];
    const push = v => {
        const uri = typeof v === 'string' ? v : (v && (v.uri || v.url || v.image_url || v.src));
        if (uri && !out.includes(uri)) out.push(uri);
    };
    if (p.init_image) push(p.init_image);
    (p.keyframes || []).forEach(k => push(k && (k.image || k.uri || k.url) || k));
    (p.reference_images || []).forEach(push);
    if (p.last_frame) push(p.last_frame);
    return out.slice(0, MAX_KEYFRAMES);
}

/**
 * Choose the workflow from what is actually attached.
 *
 * Derived rather than configured: a payload with four pictures IS an
 * omni-reference request, and letting a caller declare otherwise would send
 * four images to an endpoint that reads one and silently drop the rest — the
 * exact failure the reference-limit work exists to prevent.
 */
/**
 * KEYFRAMES ONLY. A reference picture is not a frame of the clip.
 *
 * `collectImages` returns keyframes and reference images in one flat list
 * because that is what `images_list` is, and the workflow used to be chosen by
 * counting that list. So a perfectly ordinary shot -- one storyboard keyframe
 * plus one location plate sent as a reference -- counted as TWO images and
 * selected `first-last-frame`, where position IS the meaning: the plate would
 * have become the frame the clip ENDS on. An establishing plate of an empty
 * street, as the last thing a five-second shot resolves to, for $4.25.
 *
 * Caught in preview on Northline 1B before anything was bought, but only
 * because a human was reading the payload. Counted here instead.
 */
function keyframeCount(p) {
    return (p.init_image ? 1 : 0)
        + (Array.isArray(p.keyframes) ? p.keyframes.length : 0)
        + (p.last_frame ? 1 : 0);
}

function workflowFor(p, images) {
    const asked = String(p.workflow || '').trim();
    if (WORKFLOWS[asked]) return asked;
    /*
     * RECORDED DIALOGUE travels only on omni-reference (`audios_list`), so a
     * shot sent with its voice runs there, and the board frame goes as a
     * reference rather than the exact first frame. Said in the preview.
     */
    if (Array.isArray(p.audio_references) && p.audio_references.length) return 'omni-reference';
    if (p.source_video || p.video_url) return p.extend ? 'video-extend' : 'video-edit';
    const keyframes = keyframeCount(p);
    // Two real keyframes are a start and an end, and their order is the meaning.
    if (keyframes >= 2) return 'first-last-frame';
    /*
     * ONE keyframe wins over any number of references, and this is the
     * conservative half of the fix rather than the obvious one.
     *
     * `omni-reference` would carry both the keyframe and the plates, which is
     * what the director asked for -- but every picture in `images_list` on that
     * workflow is a REFERENCE, composited and weighted, with no documented
     * guarantee that entry [0] is the frame the clip opens on. MuAPI documents
     * none, and the endpoint is unreachable from here to probe for free. Trading
     * a frame-exact opening (which is the approved board) for an unverified
     * anchor is not a trade to make silently at $0.85/s.
     *
     * So the anchor holds and the extra references are dropped -- reported, not
     * swallowed: `references_dropped` carries them into the preview. A director
     * who wants the package instead asks for it: `workflow: 'omni-reference'`
     * is honoured at the top of this function.
     */
    if (keyframes === 1) return 'image-to-video';
    // Nothing to anchor: whatever pictures there are can only be references.
    if (images.length) return 'omni-reference';
    return 'text-to-video';
}

/*
 * WHY AN EDIT IS TURNED AWAY HERE.
 *
 * RBF-001 probed `video-edit` for real money and recorded four things the
 * vendor documents nowhere — see docs/plans/rbf-001-video-edit-probe.md:
 *
 *   1. `images_list` entries are STYLE REFERENCES composited into the scene,
 *      present simultaneously and for the whole clip. They are not a start and
 *      an end frame, so an edit cannot be steered by keyframes at all.
 *   2. `duration` is IGNORED: 4s was asked for and 9.7s came back — the
 *      source's own length.
 *   3. Billing follows the SOURCE length, not the duration requested.
 *   4. A FAILED job still billed. Actual spend was $3.205 against a $0.68
 *      estimate: 4.7x, and $1.658 of it bought nothing at all.
 *
 * ICP-012 registered `aleph2` on Runway, which is a real video-to-video model
 * with documented keyframes. Beside it this tier reads as the same thing for a
 * fifth of the price, and it is not the same thing. So an EDIT is refused and
 * pointed there, rather than left as a cheaper-looking road to a measured trap.
 *
 * `video-extend` is untouched: extending a clip genuinely takes a source and is
 * not what RBF-001 measured. And the UPSCALE still uses this endpoint on
 * purpose — buildPostRequest reaches it directly at the 4k tier without coming
 * through here, because a finishing pass is not an edit.
 */
const VIDEO_EDIT_REFUSAL =
    'seedance: video-edit is not offered as an EDIT. RBF-001 measured it for real money '
    + '(docs/plans/rbf-001-video-edit-probe.md): images_list entries are STYLE REFERENCES '
    + 'composited into the scene rather than keyframes, `duration` is ignored, billing follows '
    + 'the SOURCE length rather than the duration asked for, and a FAILED job is still charged — '
    + '$3.205 actual against a $0.68 estimate. Use Runway `aleph2`, which is a real '
    + 'video-to-video model with documented keyframes: POST /film/shots/:id/video/background/'
    + 'generate, or the video_background_replace tool. This endpoint is still used for the '
    + 'UPSCALE, which is not an edit.';

function buildVideoRequest(payload) {
    const p = payload || {};
    const images = collectImages(p);
    const workflow = workflowFor(p, images);
    /*
     * Covers BOTH ways in: the implicit route (a source clip attached to a
     * plain video generation, which used to select this silently) and an
     * explicit `workflow: 'video-edit'`. Closing one and leaving the other
     * moves the trap rather than removing it.
     */
    if (workflow === 'video-edit') throw new Error(VIDEO_EDIT_REFUSAL);
    const resolution = resolutionFor(p);

    let duration = Number(p.duration_s !== undefined ? p.duration_s
        : (p.duration !== undefined ? p.duration : (p.duration_ms || 0) / 1000));
    if (!Number.isFinite(duration) || duration <= 0) duration = 5;
    const clamped = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(duration)));

    const body = {
        /*
         * MOTION FIRST. This took `p.prompt` — the STORYBOARD prompt, which
         * describes appearance, location, style and lens because it exists to
         * paint a frame from nothing. With a keyframe attached that is 81% a
         * re-description of the picture the model was just handed, and it
         * omitted environment_motion entirely.
         */
        prompt: String(p.motion_prompt || p.prompt || '').trim(),
        aspect_ratio: aspectFor(p),
        duration: clamped,
    };
    if (Number.isFinite(Number(p.seed)) && Number(p.seed) >= 0) body.seed = Number(p.seed);
    // MuAPI's own draft switch, sent only when chosen on the dialog.
    if (typeof p.muapi_draft === 'boolean' && workflow !== 'text-to-video') body.draft = p.muapi_draft;

    /*
     * SILENT BY DEFAULT, AND THAT IS A DELIBERATE DEPARTURE FROM THE PROVIDER.
     *
     * Seedance 2.5 generates audio unless told not to: `generate_audio`
     * defaults to TRUE upstream, and it is not an afterthought -- it synthesises
     * synced speech, sound effects AND background music, mono, into every clip.
     * Nothing here ever sent the field, so every generation this engine has
     * bought came back scored by the model.
     *
     * That is wrong for THIS engine specifically. Film Engine owns audio: it
     * has music cues, ambience, SFX and voice as separate capabilities, a mixer
     * and a conform stage with LUFS targets. A mono bed the picture arrives
     * with is a second, unasked-for score competing with the one the director
     * commissioned, at a level nobody set, on a track the delivery spec does
     * not account for. A studio ident with its own orchestral cue is the exact
     * case: the clip would carry ByteDance's idea of the music underneath it.
     *
     * So the default is inverted here rather than inherited. `audio: true`
     * (or `generate_audio: true`) asks for the provider's bed back, for the
     * case where a director genuinely wants the model's synced diegetic sound.
     */
    const wantsAudio = p.generate_audio !== undefined ? p.generate_audio
        : (p.audio !== undefined ? p.audio : false);
    body.generate_audio = !!wantsAudio;

    const allowed = WORKFLOWS[workflow].images;
    const used = images.slice(0, allowed);
    /*
     * WHICH FIELD CARRIES THE PICTURES IS PER WORKFLOW, and MuAPI is not
     * uniform about it. Read from its own refusals rather than assumed:
     *
     *     image-to-video     image_url      one URL, not a list
     *     first-last-frame   images_list
     *     omni-reference     images_list
     *     video-edit         images_list
     *     text-to-video      no image field at all
     *
     * This sent three names and two of them exist nowhere in that table —
     * `first_frame_image`/`last_frame_image` and `reference_images` — so both
     * paths were refused outright with
     * `{"loc":["body","images_list"],"msg":"Field required"}`. The two-keyframe
     * path and the THIRTY-reference path could not generate at all, and
     * omni-reference is the reason this adapter exists: Runway takes two.
     *
     * Only image-to-video was right, which is why single-frame generation
     * worked and made the other two look like a different problem.
     *
     * Standardising everything on `images_list` is the tempting fix and it is
     * also wrong: it repairs three and breaks the one that worked, because
     * image-to-video does not accept it. Assuming uniformity fails whichever
     * way you guess it.
     *
     * `images_list` is ORDERED, and on first-last-frame the order is the
     * meaning: [0] is the frame the clip starts on, [1] is the frame it ends
     * on. That is exactly the order `collectImages` builds.
     */
    const IMAGE_FIELD = {
        'image-to-video': 'image_url',
        'first-last-frame': 'images_list',
        'omni-reference': 'images_list',
        'video-edit': 'images_list',
        'video-extend': 'images_list',
    };
    /*
     * The map is the ONLY statement of the field name -- written out rather
     * than special-casing `image_url` and hardcoding `images_list` for the
     * rest, which made every other entry decorative: changing one to a name
     * MuAPI refuses would have emitted `images_list` anyway, and the mistake
     * would have looked corrected in the table while the request stayed wrong.
     */
    const field = IMAGE_FIELD[workflow];
    if (field && used.length) {
        // `image_url` is one URL; every other endpoint takes the ordered array.
        body[field] = field === 'image_url' ? used[0] : used;
    }
    if (p.source_video || p.video_url) body.video_url = p.source_video || p.video_url;
    const audio = (Array.isArray(p.audio_references) ? p.audio_references : [])
        .map(a => (typeof a === 'string' ? a : (a && (a.uri || a.url || a.file_path)))).filter(Boolean).slice(0, 10);
    if (workflow === 'omni-reference' && audio.length) body.audios_list = audio;

    return {
        url: `${BASE_URL}/seedance-2.5-${workflow}${RESOLUTIONS[resolution].suffix}`,
        body,
        workflow,
        resolution,
        model: `seedance-2.5-${workflow}${RESOLUTIONS[resolution].suffix}`,
        images: used,
        dropped: images.slice(allowed),
        duration_s: clamped,
        askedDuration: duration,
    };
}

/**
 * What this provider will ACTUALLY do with the request — the free preview that
 * every paid video action shows before spending. Same contract as Runway's.
 */
/**
 * The finishing pass: 480p footage taken back up to delivery size.
 *
 * Footage is generated at the draft tier so exploring a shot is affordable --
 * $0.17/s against $0.85 at 1080p means three attempts cost less than one at
 * delivery size. That plan only works if something can finish the cut, and
 * `post` was served by Gridlight alone, which does not implement
 * /postprocess. So the cheap half worked and the half that produces the
 * deliverable did not exist.
 *
 * This is the `video-edit` workflow at the `4k` tier: the finished clip goes
 * in, a larger one comes out, priced from the SAME rate card the draft floor is
 * read from -- one table, so the saving and the finishing cost cannot disagree
 * about what Seedance offers.
 *
 * ONLY `upscale`. The other three post sub-types are refused BY NAME rather
 * than quietly handled, because Seedance exposes no grade, no face restoration
 * and no compositing -- and an adapter that returns an upscaled file when asked
 * to grade reports success for work it never did.
 */
/**
 * The models a director may pick, per capability.
 *
 * ON SEEDANCE THE MODEL IS THE PRICE TIER, and that is the whole reason this
 * list exists. The WORKFLOW is derived from what is attached -- a payload with
 * four pictures IS an omni-reference request, and letting a caller declare
 * otherwise sends four images to an endpoint that reads one -- so the workflow
 * is not a choice and must not be offered as one. What IS a choice, and costs
 * between $0.17 and $1.70 a second, is the resolution. Offering that as the
 * "model" makes the dialog's cost estimate the number that will be charged.
 *
 * Nothing was offered here at all before this: the adapter declared no models,
 * so the video dialog listed MuAPI with an empty menu -- indistinguishable from
 * MuAPI being unavailable for footage.
 *
 * DERIVED FROM `RESOLUTIONS`, never typed twice, so a tier added there appears
 * on the dialog and in the rate book with nothing to remember. The id matches
 * the rate book's own key exactly, because a model whose name the pricing
 * cannot find reports its generation as free.
 *
 * The `intl` and `spicy` endpoint families MuAPI also serves are deliberately
 * NOT offered: they are separate moderation/region products at their own prices,
 * and putting them on a director's menu beside the standard tiers invites
 * picking one by accident at a rate nobody checked.
 */
const VIDEO_WORKFLOWS = ['text-to-video', 'image-to-video', 'first-last-frame', 'omni-reference'];
const POST_WORKFLOWS = ['video-edit', 'video-extend'];

function tierModels(workflows, prefix) {
    const out = {};
    for (const [tier, spec] of Object.entries(RESOLUTIONS)) {
        const id = `seedance-2.5${prefix}${spec.suffix}`;
        out[id] = {
            label: `Seedance 2.5 ${prefix ? 'video edit ' : ''}\u2014 ${tier} ($${spec.usdPerSecond.toFixed(2)}/s)`,
            resolution: tier,
            suffix: spec.suffix,
            workflows,
            usdPerSecond: spec.usdPerSecond,
        };
    }
    return Object.freeze(out);
}

const VIDEO_MODELS = tierModels(VIDEO_WORKFLOWS, '');
const POST_MODELS = tierModels(POST_WORKFLOWS, '-video-edit');

/*
 * MUAPI'S DEDICATED VIDEO UPSCALERS. The Seedance video-edit finish re-renders
 * the clip (RBF-001: it bills the source, ignores the requested length, and
 * charges a failed job). These only enlarge it, and they are the right tool
 * when a clip came back below the delivery size.
 *
 * Fields probed free against MuAPI's validation on 2026-09-29:
 *   topaz-video-upscale    video_url, upscale_factor 1|2|4
 *   ai-video-upscaler(-pro) video_url, resolution 720p|1080p|2k|4k
 *   flux-3-video-upscaler  video_url, prompt, upscale_factor (a number)
 * Prices are MuAPI's catalogue figures, which carry no unit; they are held per
 * second of source (the direction that over-estimates) and marked inferred.
 */
const UPSCALE_TIERS = Object.freeze({ '720p': 1280, '1080p': 1920, '2k': 2560, '4k': 3840 });
const UPSCALERS = Object.freeze({
    'topaz-video-upscale': { endpoint: 'topaz-video-upscale', label: 'Topaz video upscale (2x or 4x)', control: 'factor', factors: [1, 2, 4], usdPerSecond: 0.08 },
    'ai-video-upscaler': { endpoint: 'ai-video-upscaler', label: 'AI video upscaler (to 1080p, 2K or 4K)', control: 'resolution', usdPerSecond: 0.03 },
    'ai-video-upscaler-pro': { endpoint: 'ai-video-upscaler-pro', label: 'AI video upscaler Pro (to 1080p, 2K or 4K)', control: 'resolution', usdPerSecond: 0.24 },
    'flux-3-video-upscaler': { endpoint: 'flux-3-video-upscaler', label: 'FLUX.3 video upscaler (prompted)', control: 'factor', factors: [2, 3, 4], prompt: true, usdPerSecond: 1.43 },
});

/**
 * The request for a dedicated upscaler, sized to REACH the delivery: the
 * smallest factor or tier that brings the source's long edge to the target's,
 * else the largest it offers (and it says so).
 */
function buildUpscaleRequest(p, model) {
    const spec = UPSCALERS[model];
    const source = p.source_video || p.video_url || p.input_url || p.input_video || p.init_video;
    if (!source) throw new Error(`seedance: ${model} needs the clip to upscale (source_video)`);
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(String(p.target_resolution || ''));
    const targetLong = Number(p.target_long_edge) || (m ? Math.max(Number(m[1]), Number(m[2])) : 3840);
    const sourceLong = Math.max(Number(p.source_width) || 0, Number(p.source_height) || 0);
    const body = { video_url: source };
    let reaches = null, note = null;
    if (spec.control === 'factor') {
        const need = sourceLong ? targetLong / sourceLong : 2;
        const f = spec.factors.find(x => x >= need - 1e-6) || spec.factors[spec.factors.length - 1];
        body.upscale_factor = Number(p.upscale_factor) || f;
        if (sourceLong) {
            reaches = Math.round(sourceLong * body.upscale_factor);
            if (reaches < targetLong) note = `${model} goes to ${body.upscale_factor}x at most, which brings ${sourceLong}px to ${reaches}px, short of ${targetLong}px.`;
        }
    } else {
        const tier = Object.keys(UPSCALE_TIERS).find(t => UPSCALE_TIERS[t] >= targetLong) || '4k';
        body.resolution = String(p.resolution && UPSCALE_TIERS[String(p.resolution).toLowerCase()] ? p.resolution : tier).toLowerCase();
        reaches = UPSCALE_TIERS[body.resolution];
        if (reaches < targetLong) note = `${model} goes to 4K at most, short of ${targetLong}px.`;
    }
    if (spec.prompt) body.prompt = String(p.prompt || 'Upscale this clip faithfully: sharper detail, the same picture.').trim();
    const sourceSeconds = Number(p.source_seconds !== undefined ? p.source_seconds : (p.source_duration_ms || 0) / 1000);
    const known = Number.isFinite(sourceSeconds) && sourceSeconds > 0;
    return {
        url: `${BASE_URL}/${spec.endpoint}`, body, images: [], workflow: 'upscale', model, reaches, note,
        usd_per_second: spec.usdPerSecond,
        estimated_usd: known ? Number((spec.usdPerSecond * sourceSeconds).toFixed(2)) : null,
        source_seconds: known ? sourceSeconds : null,
        estimate_unknown_why: known ? null : 'The source clip has not been measured, so the price is unknown.',
    };
}

const POST_SERVED = Object.freeze({
    upscale: true,
    face_restore: false,   // Seedance exposes no face-restoration workflow
    color_grade: false,    // Seedance exposes no grade workflow
    composite: false,      // compositing is an editorial act, not a generation
});

function buildPostRequest(payload) {
    const p = payload || {};
    const type = String(p.type || p.job_type || 'upscale').trim();
    const upscaler = String(p.model || p.upscaler || '');
    if (type === 'upscale' && UPSCALERS[upscaler]) return buildUpscaleRequest(p, upscaler);

    if (!POST_SERVED[type]) {
        throw new Error(`seedance: ${type} is not served here -- Seedance offers a video-edit `
            + 'workflow at a larger tier, which is an upscale; it exposes no grade, no face '
            + 'restoration and no compositing. Do this one in the NLE.');
    }

    /*
     * `input_url` IS THE ONE THE ORCHESTRATOR SENDS. capability-payloads' post()
     * emits it and this list did not contain it, so the orchestrated finishing
     * pass could never reach Seedance — the whole reason this provider was
     * added for `post` — and the refusal named four fields the caller does not
     * produce, which reads as a missing clip rather than a field-name mismatch.
     */
    const source = p.source_video || p.video_url || p.input_url || p.input_video || p.init_video;
    if (!source) {
        /*
         * Refused, never sent. Without a clip the video-edit workflow has
         * nothing to edit and would generate something NEW from the prompt --
         * a paid request returning a clip that is not the film, presented as
         * the finished shot.
         */
        throw new Error('seedance: an upscale needs the finished clip (source_video) -- with no '
            + 'source video there is nothing to finish, and the workflow would generate a new one');
    }

    /*
     * 4K by default because that is what the finishing pass is FOR, and
     * overridable because a 1080p delivery billed at the 4K rate is money spent
     * on pixels nobody ships. Same precedence the draft path uses: what the
     * caller asked for wins.
     */
    const asked = String(p.resolution || p.quality || '').trim().toLowerCase();
    const resolution = RESOLUTIONS[asked] ? asked : '4k';

    let duration = Number(p.duration_s !== undefined ? p.duration_s : (p.duration_ms || 0) / 1000);
    if (!Number.isFinite(duration) || duration <= 0) duration = 5;
    const clamped = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(duration)));

    // What the provider will actually bill for, when anybody has measured it.
    const sourceSeconds = Number(p.source_seconds !== undefined ? p.source_seconds
        : (p.source_duration_ms || 0) / 1000);

    const body = {
        prompt: String(p.prompt || '').trim(),
        video_url: source,
        duration: clamped,
    };
    if (p.aspect_ratio || p.target_resolution) body.aspect_ratio = aspectFor(p);

    return {
        url: `${BASE_URL}/seedance-2.5-video-edit${RESOLUTIONS[resolution].suffix}`,
        body,
        images: [],
        workflow: 'video-edit',
        resolution,
        usd_per_second: RESOLUTIONS[resolution].usdPerSecond,
        /*
         * PRICED FROM THE SOURCE, or not priced at all.
         *
         * RBF-001 finding 3: this endpoint ignores `duration` and bills the
         * clip handed in. The estimate multiplied a DEFAULTED five seconds by
         * the 4k rate and returned $8.50 for every clip there has ever been —
         * a confident number that is not the price, which is the same defect
         * ICP-013 fixed on aleph2 one provider over.
         *
         * An unmeasured source is refused rather than guessed: a default length
         * is wrong by however much the real clip differs and nobody would know
         * it was invented.
         */
        estimated_usd: Number.isFinite(sourceSeconds) && sourceSeconds > 0
            ? Number((RESOLUTIONS[resolution].usdPerSecond * sourceSeconds).toFixed(2))
            : null,
        source_seconds: Number.isFinite(sourceSeconds) && sourceSeconds > 0 ? sourceSeconds : null,
        estimate_unknown_why: Number.isFinite(sourceSeconds) && sourceSeconds > 0 ? null
            : 'This endpoint bills the SOURCE clip, not the duration requested (RBF-001), and the '
              + 'source has not been measured. Pass source_seconds — lib/ffmpeg.js inspectMedia '
              + 'reads it — or the only honest answer is that the price is unknown.',
    };
}

function describeVideoRequest(payload) {
    const p = payload || {};
    const built = buildVideoRequest(p);
    const notes = [];

    if (Math.round(built.askedDuration) !== built.duration_s) {
        notes.push(`Length: ${built.askedDuration}s is outside 4–30s — it will generate ${built.duration_s}s.`);
    }
    if (built.workflow === 'text-to-video') {
        notes.push('No image is attached, so this generates from words alone.');
    }
    if (built.body.audios_list && built.body.audios_list.length) {
        notes.push(`${built.body.audios_list.length} recorded dialogue clip(s) travel as audio references. They go on the `
            + 'omni-reference workflow, where the storyboard frame is a reference rather than the exact first frame.');
    }
    if (built.workflow === 'omni-reference') {
        notes.push(`${built.images.length} pictures travel as references — Seedance reconciles them into one sequence.`);
    }
    if (built.dropped.length) {
        notes.push(`${built.dropped.length} picture(s) beyond what this workflow accepts will not be sent.`);
    }
    if (built.resolution === '4k') {
        notes.push('4K is $1.70 per second — five times 1080p. Change the project delivery resolution to lower it.');
    }
    /*
     * SAY IT WHEN THE ASK IS NOT A TIER THIS PROVIDER HAS.
     *
     * Never rounding up is correct — a resolution nobody asked for is a bill
     * nobody expected — but doing it without a word is how a 2K project is
     * delivered at 1080p and nobody finds out until someone measures a frame.
     */
    const tier = resolutionDecision(p);
    if (tier.snapped) {
        notes.push(`This asks for ${tier.asked} (${tier.asked_long_edge}px long edge). Seedance `
            + `documents 480p, 720p, 1080p and 4K only, so it will render `
            + `${tier.resolution} (${tier.served_long_edge}px) — the nearest tier at or BELOW the ask, `
            + 'never above it. Finish it up with the post/upscale pass if you need the full raster.');
    }
    if (built.body.generate_audio) {
        notes.push('Audio ON: Seedance will synthesise synced speech, sound effects and a mono '
            + 'music bed into this clip. Film Engine\'s own cues, ambience and mix are separate — '
            + 'two scores will arrive on one timeline.');
    }
    if (p.camera_control && Array.isArray(p.camera_control.path) && p.camera_control.path.length > 1) {
        notes.push('The approved 3D camera path is translated into prompt text; Seedance does not receive Film Engine coordinates.');
    }

    const perSecond = RESOLUTIONS[built.resolution].usdPerSecond;
    return {
        provider: 'seedance',
        mode: built.workflow,
        // What was asked for beside what will render — the two are not always
        // the same and the difference is the thing worth seeing.
        resolution_asked: tier.asked,
        resolution_snapped: tier.snapped,
        model: built.model,
        duration_s: built.duration_s,
        aspect_ratio: built.body.aspect_ratio,
        resolution: built.resolution,
        prompt: built.body.prompt,
        prompt_length: built.body.prompt.length,
        reference_count: built.images.length,
        has_image: built.images.length > 0,
        // Stated because the provider's default is the opposite of this
        // engine's, and a clip that arrives scored is not obviously wrong until
        // it is played against the cue it was supposed to carry.
        audio: !!built.body.generate_audio,
        estimated_usd: Number((perSecond * built.duration_s).toFixed(2)),
        notes,
    };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function awaitResult(requestId, apiKey, deadline, onPoll) {
    const url = `${BASE_URL}/predictions/${encodeURIComponent(requestId)}/result`;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        let res;
        try {
            res = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
        } catch (err) {
            return { ok: false, status: 502, error: `seedance: polling failed — ${err.message}` };
        }
        const data = await res.json().catch(() => null);
        if (!data) continue;
        const status = String(data.status || '').toLowerCase();
        if (onPoll && !['completed', 'succeeded', 'failed', 'error', 'cancelled'].includes(status)) {
            try { onPoll(data, status); } catch (_) { /* never ends the poll */ }
        }
        if (status === 'completed' || status === 'succeeded') {
            /*
             * `outputs`, PLURAL, AND IT IS AN ARRAY OF STRINGS.
             *
             * This read `data.output`. MuAPI documents the result as
             *
             *   { "id": ..., "status": "completed",
             *     "outputs": ["https://cdn.muapi.ai/....mp4"], "cost": {...} }
             *
             * so the poll saw "completed", looked at a key that does not exist,
             * and reported "completed with no video" — on a clip that had
             * rendered and been CHARGED FOR. The worst shape of failure: the
             * money leaves, the file exists, and the caller is told nothing was
             * made. The singular form is kept as a fallback because it costs
             * nothing to accept, and object forms because a URL is a URL.
             */
            const pick = v => (typeof v === 'string' ? v : (v && (v.video_url || v.url || v.uri)) || '');
            const outs = Array.isArray(data.outputs) ? data.outputs
                : (data.outputs ? [data.outputs] : []);
            const legacy = Array.isArray(data.output) ? data.output
                : (data.output ? [data.output] : []);
            const url2 = [...outs, ...legacy].map(pick).find(Boolean);
            if (!url2) {
                return { ok: false, status: 502,
                    error: `seedance: completed but no output URL in the result — keys: ${Object.keys(data || {}).join(', ') || 'none'}` };
            }
            return { ok: true, url: url2 };
        }
        if (status === 'failed' || status === 'error' || status === 'cancelled') {
            return { ok: false, status: 422, error: `seedance: ${data.error || status}` };
        }
    }
    return { ok: false, status: 504, error: 'seedance: timed out waiting for the video' };
}

async function generate(capability, payload, opts) {
    if (capability !== 'video' && capability !== 'post') {
        return { ok: false, status: 400, error: `seedance: ${capability} is not served here` };
    }

    /*
     * The post builder REFUSES three of the four sub-types, and that refusal is
     * the answer -- so it runs before the credential check. Telling someone
     * their key is missing when the real problem is that Seedance cannot grade
     * sends them to look in the wrong place.
     */
    let req;
    if (capability === 'post') {
        try { req = buildPostRequest(payload); }
        catch (err) { return { ok: false, status: 400, error: err.message }; }
    }

    const { apiKey } = getCredential('seedance');
    if (!apiKey) return { ok: false, status: 401, error: 'seedance: no API key configured' };

    if (!req) {
        req = buildVideoRequest(payload);
        if (!req.body.prompt && !req.images.length) {
            return { ok: false, status: 400, error: 'seedance: nothing to generate from' };
        }
    }

    /*
     * THE PICTURES GO UP BEFORE THE REQUEST GOES OUT.
     *
     * MuAPI addresses images by URL and refuses a data URI — `url_too_long`,
     * a 2083-character ceiling — while this engine holds keyframes as local
     * files and inlines them. So the bytes are uploaded to MuAPI's own free
     * `upload_file` endpoint and the returned URLs go in the payload.
     *
     * HERE, not in buildVideoRequest, because the builder is PURE: the dry run
     * prints it without a socket, and an uploader inside it would either spend
     * network on a report or print a payload that is not the one sent.
     */
    /*
     * BOTH FIELDS, because the workflow decides which one carries the picture.
     *
     * This hosted `images_list` only. But `image-to-video` — the ordinary case,
     * one keyframe and a prompt — puts its single picture in `image_url`, and
     * that field went out as the raw data URI every time. MuAPI refused it with
     * the exact error this module's own header documents:
     *
     *   {"type":"url_too_long","loc":["body","image_url"], ...}
     *
     * So the paths that worked were the ones that happen to send two or more
     * pictures — a sequence leg, a repair — and generating a clip for ONE shot
     * was impossible on this adapter. The upload is free and the ceiling is a
     * property of the vendor rather than of the endpoint, so it applies to
     * every field that carries an image.
     */
    /*
     * A CLIP TO FINISH IS A LOCAL FILE, and MuAPI fetches by URL. The finish
     * used to post the path itself, which MuAPI cannot reach, so it could never
     * have worked on a real clip. It goes up through the same free upload.
     */
    if (capability === 'post' && typeof req.body.video_url === 'string' && !/^https?:\/\//i.test(req.body.video_url)) {
        const { hostFile } = require('./muapi-upload');
        const hosted = await hostFile(req.body.video_url, apiKey);
        if (!hosted.ok) return { ok: false, status: 422, error: `seedance: ${hosted.error}` };
        req.body.video_url = hosted.url;
    }
    // Recorded dialogue: local files go up the same free way a clip does.
    if (Array.isArray(req.body.audios_list) && req.body.audios_list.some(a => !/^https?:\/\//i.test(a))) {
        const { hostFile } = require('./muapi-upload');
        const urls = [];
        for (const a of req.body.audios_list) {
            const h = await hostFile(a, apiKey);
            if (!h.ok) return { ok: false, status: 422, error: `seedance: dialogue audio — ${h.error}` };
            urls.push(h.url);
        }
        req.body.audios_list = urls;
    }
    const imageFields = ['images_list', 'image_url', 'first_frame_image', 'last_frame_image'];
    for (const field of imageFields) {
        const v = req.body[field];
        const list = Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : null);
        // Only what actually needs hosting: a URL the vendor can already fetch
        // is left exactly as it is.
        if (!list || !list.some(x => typeof x === 'string' && x.startsWith('data:'))) continue;
        const { hostImages } = require('./muapi-upload');
        const hosted = await hostImages(list, apiKey);
        if (!hosted.ok) return { ok: false, status: 422, error: `seedance: ${hosted.error}` };
        req.body[field] = Array.isArray(v) ? hosted.urls : hosted.urls[0];
    }

    let res;
    try {
        res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, accept: 'application/json' },
            body: JSON.stringify(req.body),
        });
    } catch (err) {
        return { ok: false, status: 502, error: `seedance: ${err.message}` };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
        const detail = (data && (data.error || data.detail || data.message)) || `HTTP ${res.status}`;
        return { ok: false, status: res.status, error: `seedance: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` };
    }
    const requestId = data.request_id || data.id;
    if (!requestId) return { ok: false, status: 502, error: 'seedance: no request id returned' };

    /*
     * The handle, written down BEFORE polling. Everything after this line can
     * be torn down without losing the job.
     */
    if (opts && typeof opts.onHandle === 'function') {
        try { opts.onHandle(requestId, { capability }); } catch (_) { /* never blocks a paid call */ }
    }
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    const { emit, pollPercent } = require('../generation-progress');
    emit(opts, { phase: 'queued' });
    const out = await awaitResult(requestId, apiKey, Date.now() + budget, (body, status) =>
        emit(opts, { percent: pollPercent(body), phase: status || 'generating' }));
    if (!out.ok && out.status === 504 && opts && opts.onTimeout) return opts.onTimeout(requestId, budget);
    if (!out.ok) return out;
    return {
        ok: true,
        url: out.url,
        provider: 'seedance',
        provider_model: req.model,
        duration_s: req.duration_s,
        /*
         * Whether sound was ASKED for, carried on the result so the persist
         * step does not have to guess. It strips the audio track by default —
         * because asking this provider for silence does not produce it — and
         * this is how a caller who genuinely wanted the model's sound keeps it.
         */
        audio: !!req.body.generate_audio,
        // The meter prices in seconds at this resolution's rate.
        usage: { seconds: req.duration_s, resolution: req.resolution },
    };
}

/**
 * What the call consumed. Per second — and the RESOLUTION multiplies it
 * fivefold from 720p to 4K, so it has to reach the model id or a 4K render
 * reports as a 720p one.
 */
function meterSeedance(capability, payload, result) {
    if (capability !== 'video' && capability !== 'post') return null;

    /*
     * An upscale is billed per second at its tier's rate exactly as a
     * generation is -- same table, same unit. Metered through the POST builder
     * though, because the two resolve their tier differently: footage defaults
     * to the draft floor and a finish defaults to 4K, so metering an upscale
     * through the video builder would report a $51 finish as an $8 one.
     */
    if (capability === 'post') {
        let built;
        try { built = buildPostRequest(payload || {}); }
        catch (err) { return null; }   // refused before anything was spent
        if (built.workflow === 'upscale') {
            return { unit: 'second', quantity: Math.max(1, built.source_seconds || Number(result && result.duration_s) || 1), model: built.model };
        }
        const secs = (result && Number(result.duration_s)) || built.body.duration;
        const suffix = built.resolution === '720p' ? '' : `-${built.resolution}`;
        return {
            unit: 'second',
            quantity: Math.max(1, secs),
            model: `seedance-2.5-video-edit${suffix}`,
        };
    }

    const built = buildVideoRequest(payload || {});
    const seconds = (result && Number(result.duration_s)) || built.duration_s;
    const res = (result && result.usage && result.usage.resolution) || built.resolution;
    const model = res === '720p' ? 'seedance-2.5' : `seedance-2.5-${res}`;
    return { unit: 'second', quantity: Math.max(1, seconds), model };
}


/**
 * Finish a job from its handle.
 *
 * The other half of `onHandle`: the id was written down before polling, and
 * this is what turns it back into bytes when the call that started it was
 * abandoned. Same poll function the live path uses, so a collected result
 * cannot differ from one that arrived normally.
 */
async function collect(requestId, opts) {
    const { apiKey } = getCredential('seedance');
    if (!apiKey) return { ok: false, status: 401, error: 'seedance: no API key configured' };
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    return awaitResult(String(requestId), apiKey, Date.now() + budget);
}

/**
 * What Seedance will really deliver: its tier, never rounded up, reshaped to
 * the working aspect. An ask above 4K gets 4K; an ask between two tiers gets
 * the lower one and is told so; a model chosen at a fixed tier is that tier.
 */
function deliverableFrame(payload) {
    const p = payload || {};
    const frame = predictedFrame(p);
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(String(p.target_resolution || ''));
    const askedLong = Math.max(Number(p.width) || 0, Number(p.height) || 0) || (m ? Math.max(Number(m[1]), Number(m[2])) : 0);
    const deliveredLong = Math.max(frame.width, frame.height);
    const downgraded = !!(askedLong && deliveredLong < askedLong);
    const chosen = String(p.resolution || p.quality || '') || (VIDEO_MODELS[p.model] ? `${frame.tier} (the model chosen)` : '');
    return { width: frame.width, height: frame.height, tier: frame.tier, downgraded,
        why: downgraded ? (chosen
            ? `Seedance renders the ${frame.tier} tier because ${chosen.includes('model') ? 'the model chosen is that tier' : `${chosen} was asked explicitly`}; the project asks ${askedLong} wide.`
            : `Seedance offers 480p, 720p, 1080p and 4K and never rounds up; ${frame.tier} is its best at or below ${askedLong} wide.`) : null };
}

const seedanceAdapter = {
    deliverableFrame,
    // Asked directly by the readiness checks as well as by resolve(): an
    // adapter that cannot answer "do you serve this?" is treated as not
    // serving it, and is quietly skipped as a preference.
    supports: capability => (seedanceAdapter.capabilities || []).includes(capability),
    meter: meterSeedance,
    id: 'seedance',
    kind: 'generator',
    // Labelled for the ACCOUNT, not the model: the key pasted here is a MuAPI
    // account key that also reaches the Nano Banana image adapter, and a label
    // naming ByteDance is why it was pasted twice under two names.
    label: 'MuAPI (Seedance 2.5 video)',
    account: 'MuAPI',
    requiresKey: true,
    capabilities: ['video', 'post'],

    /*
     * The model this adapter generates with, named so the DRAFT path can find
     * its floor.
     *
     * `draftFrameFor` is keyed by model, and a video payload carries a model
     * only when a caller passes one -- so without this the lookup received
     * `undefined`, missed the 480p entry and fell to the conservative 720p
     * default. Drafting reported itself active and the clip was billed at twice
     * the draft rate, silently.
     *
     * 2.5 explicitly: `seedance2` (2.0) is a different product at different
     * rates that documents no 480p tier at all.
     */
    defaultModel: 'seedance-2.5',

    /*
     * Asynchronous: the provider accepts the job and returns an id, and the
     * result is polled for. Declared so the handle machinery can find it -- a
     * tool call abandoned mid-poll loses a generation that was already billed
     * unless the id was written down first.
     */
    asyncGeneration: true,
    /** No cancel this adapter can perform: "stop waiting" leaves the job collectable (PGN-012). */
    cancel: 'stop_waiting',
    /** Seedance through MuAPI: a phase from the poll, a percentage only if one is sent. */
    reportsProgress: 'phase',

    /*
     * WHAT THIS ADAPTER WILL CARRY, in the shape lib/video-reference speaks.
     *
     * `CONTRACTS` over there is keyed by RUNWAY's model catalogue — `hailuo3`,
     * `seedance2_5` — because that is where reference contracts were first
     * needed. A project on THIS adapter reaches Seedance directly through
     * MuAPI, so `contractFor()` was handed a null model, fell to KEYFRAME_ONLY,
     * and dropped every `inbetween` reference on the floor.
     *
     * The consequence is not small. The strip — a bundle of stations sent as
     * references on ONE longer generation instead of N-1 first/last legs — is
     * the engine's own answer to the defect that every pinned keyframe is a
     * moment of ZERO MOTION and an approximate landing. Chained legs therefore
     * freeze and re-pose at every join. The contract written for exactly this
     * model, with the comment "the only model that documents room for a strip",
     * could never be selected on the provider it was written about.
     *
     * Declared here rather than added to that table because the numbers are
     * this adapter's own and already stated above: 30 images, 10 videos, 10
     * audio, from MuAPI's omni-reference workflow.
     */
    referenceContract: Object.freeze({
        roles: Object.freeze(['keyframe', 'inbetween', 'character', 'creature', 'prop',
                              'location', 'style', 'motion', 'audio']),
        maxImages: MAX_KEYFRAMES, maxVideos: 10, maxAudio: 10,
        why: 'MuAPI documents the seedance-2.5-omni-reference workflow at up to 30 images, '
            + '10 videos and 10 audio clips; the images are free and the VIDEO is billed per '
            + 'second, so a longer single clip costs the same as the legs it replaces',
    }),

    // Thirty. This is the reason it is here: Runway takes two.
    maxKeyframes: MAX_KEYFRAMES,
    keyframeNote: 'The seedance-2.5-omni-reference endpoint accepts up to 30 reference images '
        + '(plus 10 videos and 10 audio clips). Below three pictures the adapter routes to '
        + 'first-last-frame or image-to-video instead, which take 2 and 1.',
    maxReferenceImages: MAX_KEYFRAMES,
    supportsReferenceImages: true,
    supportsReferenceTags: false,
    referenceMode: 'condition',
    // No documented prompt limit; held at the largest figure used here rather
    // than assumed unbounded, because over-sending is a rejection at the
    // provider and trimming is reportable.
    promptLimit: 16000,
    supportsNegativePrompt: 'folded',
    supportsSeed: true,
    maxImagePixels: 3840 * 2160,

    resolutions: RESOLUTIONS,
    workflows: WORKFLOWS,

    // Per capability: this adapter serves two, and one flat list would offer
    // video tiers to the finishing pass and edit tiers to a clip.
    modelsByCapability: { video: VIDEO_MODELS, post: { ...POST_MODELS, ...UPSCALERS } },
    buildVideoRequest,
    describeVideoRequest,
    generate,
    collect,
    /*
     * The poll, exported so it can be TESTED against the shapes MuAPI actually
     * answers with. It was a private function, and the bug it hid -- reading
     * `output` where the API returns `outputs` -- cost a rendered clip and was
     * unreachable from any test. A result parser that both roads depend on
     * should be assertable without buying a generation.
     */
    awaitResult,

    connection: {
        instructions: 'This is your MuAPI account key \u2014 the same one the Nano Banana image '
            + 'adapter uses. Create it at muapi.ai and paste it once; whichever of the two you '
            + 'save it under, both read it.',
        helpUrl: 'https://muapi.ai/',
    },
};

module.exports = { adapter: seedanceAdapter, seedanceAdapter, buildVideoRequest,
    MIN_DURATION, MAX_DURATION,
    buildPostRequest, POST_SERVED, describeVideoRequest, RESOLUTIONS, WORKFLOWS,
    VIDEO_MODELS, POST_MODELS, UPSCALERS, buildUpscaleRequest, generate, collect, awaitResult, resolutionDecision, predictedFrame };
