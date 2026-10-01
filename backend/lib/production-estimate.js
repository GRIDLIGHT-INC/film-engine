/**
 * What making this film will cost, before anything is made.
 *
 * "When we have a script and know the time of the movie, in the budget section
 *  we should see an estimate of the cost based on the number of images we'll
 *  have to generate for all the plates, storyboard and footage, based on what
 *  provider is currently selected for each type and their costs per image or
 *  footage per second at the resolution of the project. We could select a
 *  different resolution and provider to see the difference in cost."
 *
 * Three quantities, each COUNTED from the project rather than guessed:
 *
 *   plates      every character, location and prop, times the views its sheet
 *               holds (a character's turnaround is four pictures)
 *   storyboard  one frame per shot; before the breakdown, the screenplay's
 *               own running time cut into shots of a stated average length
 *   footage     each shot's own length; before the breakdown, the running
 *               time — measured screen time from the screenplay, else the
 *               project's target length
 *
 * And priced the way the generation will be BILLED: through the adapter's own
 * meter over a payload at the chosen size, then the rate book. That is the path
 * the video preview already prices a clip by, so the estimate and the
 * confirmation cannot disagree about one shot. Runway video goes through the
 * Runway estimator, which knows its per-resolution rates and minimum charges.
 *
 * Nothing here generates, spends or writes. Every number is a FIRST ATTEMPT;
 * `takes` multiplies a category for the regenerations a director expects, and
 * the answer says so rather than pretending the first roll is the shot.
 */
const providers = require('./providers');
const { priceUsage, rateFor } = require('./provider-pricing');

function db() { return require('../db/database').db; }

/** How many pictures each subject's sheet holds by default. Editable per estimate. */
const DEFAULT_VIEWS = Object.freeze({
    character: 4,   // front, left profile, right profile, back
    location: 4,    // the hero plate and three sides
    prop: 1,        // the product plate; a prop sheet can hold more
});
const DEFAULT_SHOT_SECONDS = 4;
const CATEGORIES = Object.freeze(['plates', 'storyboard', 'footage']);

const round2 = n => Math.round(n * 100) / 100;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** A resolution from a preset id or WxH, else the project's own. */
function resolveRaster(asked, projectRes) {
    const { RESOLUTIONS } = require('./project-presets');
    const preset = RESOLUTIONS.find(r => r.id === asked);
    if (preset) return { id: preset.id, label: preset.label, width: preset.width, height: preset.height };
    const m = /^(\d{3,5})\s*x\s*(\d{3,5})$/i.exec(String(asked || projectRes || ''));
    if (m) {
        const w = Number(m[1]), h = Number(m[2]);
        const named = RESOLUTIONS.find(r => r.width === w && r.height === h);
        return { id: named ? named.id : `${w}x${h}`, label: named ? named.label : `${w}x${h}`, width: w, height: h };
    }
    return { id: '2k', label: '2K', width: 2048, height: 1080 };
}

/** What the project has to make, counted. */
function countWork(projectId, opts = {}) {
    const d = db();
    const project = d.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return null;
    const count = t => d.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project_id = ?`).get(projectId).n;
    const subjects = { character: count('film_characters'), location: count('film_locations'), prop: count('film_props') };
    const views = {};
    for (const k of Object.keys(DEFAULT_VIEWS)) views[k] = Math.round(num(opts.views && opts.views[k], DEFAULT_VIEWS[k]));

    const shots = d.prepare(`SELECT sh.id, sh.shot_code, sh.duration_ms FROM film_shots sh
        JOIN film_scenes s ON s.id = sh.scene_id
        WHERE s.project_id = ? AND COALESCE(s.status, '') != 'removed'`).all(projectId);

    // The running time, and where it came from.
    let runtime = null;
    const sumShots = shots.reduce((n, s) => n + (Number(s.duration_ms) > 0 ? Number(s.duration_ms) : 0), 0) / 1000;
    if (num(opts.runtime_seconds, 0)) runtime = { seconds: Number(opts.runtime_seconds), source: 'entered here' };
    else if (shots.length && shots.every(s => Number(s.duration_ms) > 0)) runtime = { seconds: sumShots, source: 'the shots\' own lengths' };
    if (!runtime) {
        try {
            const script = d.prepare('SELECT * FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId);
            if (script) {
                const { sceneBlocks } = require('../routes/story-development');
                const t = require('./screenplay-timing').estimateScreenplay(sceneBlocks(script));
                if (t.likely_runtime_seconds > 0) {
                    runtime = { seconds: t.likely_runtime_seconds, source: 'the screenplay\'s likely screen time',
                        range: [t.minimum_runtime_seconds, t.maximum_runtime_seconds], pages: t.pages };
                }
            }
        } catch (_) { /* no screenplay timing is an answer, said below */ }
    }
    if (!runtime && Number(project.target_duration_ms) > 0) {
        runtime = { seconds: Number(project.target_duration_ms) / 1000, source: 'the project\'s target length' };
    }

    const avg = num(opts.shot_seconds, DEFAULT_SHOT_SECONDS);
    let clips;
    let shotSource;
    if (shots.length) {
        // A shot with no length of its own takes its share of what is left.
        const unset = shots.filter(s => !(Number(s.duration_ms) > 0));
        const left = runtime ? Math.max(0, runtime.seconds - sumShots) : 0;
        const share = unset.length ? Math.max(2, left > 0 ? left / unset.length : avg) : 0;
        clips = shots.map(s => Number(s.duration_ms) > 0 ? Number(s.duration_ms) / 1000 : share);
        shotSource = unset.length
            ? `${shots.length} shots from the breakdown; ${unset.length} without a length are given ${round2(share)}s each`
            : `${shots.length} shots from the breakdown, at their own lengths`;
    } else if (runtime) {
        const n = Math.max(1, Math.ceil(runtime.seconds / avg));
        clips = Array.from({ length: n }, () => runtime.seconds / n);
        shotSource = `no shots yet: ${round2(runtime.seconds)}s cut into ${n} shots of about ${avg}s`;
    } else {
        clips = [];
        shotSource = 'no shots, no screenplay timing and no target length: nothing to count yet';
    }
    return { project, subjects, views, shots: shots.length, clips, runtime, shot_source: shotSource, shot_seconds: avg };
}

/** The provider and model a capability will run on for this project, or the ones asked for. */
function chooseGenerator(capability, config, asked = {}) {
    const resolved = asked.provider ? { id: asked.provider, source: 'chosen here', explicit: true }
        : providers.resolveIdWithReason(capability, config);
    const adapter = resolved && resolved.id ? providers.get(resolved.id) : null;
    if (!adapter || !(adapter.capabilities || []).includes(capability)) {
        return { capability, provider: resolved && resolved.id || null, error: `no provider serves ${capability} here` };
    }
    let model = asked.model || null;
    if (!model) model = providers.pinnedModelFor(capability, config, adapter);
    if (!model && capability === 'image') model = require('./image-standard').standardModelFor(adapter.id);
    const offered = providers.modelIdsFor(adapter, capability) || [];
    if (model && offered.length && !offered.includes(model)) {
        return { capability, provider: adapter.id, error: `${adapter.label || adapter.id} does not offer the model ${model}` };
    }
    return {
        capability, provider: adapter.id, provider_label: adapter.label || adapter.id, model: model || null,
        source: asked.provider ? 'chosen here' : (resolved.source || null),
        credentialed: providers.isProviderConfigured(adapter.id) || !adapter.requiresKey,
        models: offered,
    };
}

/** One picture at a size, priced through the adapter's own meter. */
function priceImage(gen, size) {
    const adapter = providers.get(gen.provider);
    let usage = null;
    if (adapter && typeof adapter.meter === 'function') {
        try { usage = adapter.meter('image', { model: gen.model || undefined, width: size.width, height: size.height }, null); }
        catch (_) { usage = null; }
    }
    if (!usage) {
        const r = rateFor(gen.provider, 'image', gen.model);
        if (!r) return { usd: null, why: `no rate for ${gen.provider} images` };
        const units = r.unit === 'megapixel' ? (size.width * size.height) / 1e6 : 1;
        usage = { unit: r.unit, quantity: units, model: gen.model };
    }
    const p = priceUsage({ provider: gen.provider, capability: 'image', ...usage });
    if (!p || !p.priced) return { usd: null, why: `no rate for ${gen.provider} ${usage.model || ''}`.trim() };
    const r = rateFor(gen.provider, 'image', usage.model) || {};
    return { usd: p.amount_usd, model: usage.model || gen.model, inferred: !!r.inferred, self_hosted: !!r.self_hosted };
}

/** One clip of a length at a size. Runway through its estimator (tiers, minimums), the rest through their meter. */
/** The frame a video generator will really deliver when asked for this one. */
function deliveredFrame(gen, frame) {
    const adapter = providers.get(gen.provider);
    try {
        const d = require('./delivery-quality').deliveryDecision(adapter,
            { model: gen.model || undefined, target_resolution: `${frame.width}x${frame.height}` });
        return { delivered: d.delivered, downgraded: !!d.downgraded, why: d.why || null };
    } catch (_) { return { delivered: null, downgraded: null, why: null }; }
}

function priceClip(gen, seconds, frame) {
    const secs = Math.max(1, Math.round(seconds));
    const out = deliveredFrame(gen, frame);
    if (gen.provider === 'runway') {
        // Priced at the tier of the frame Runway will actually send, as the confirmation is.
        const est = require('./video-cost').estimateVideoCost({
            model: gen.model || process.env.RUNWAY_VIDEO_MODEL || 'gen4.5',
            frame: out.delivered || `${frame.width}x${frame.height}`, durationSeconds: secs });
        if (est.unknownModel) return { usd: null, why: est.note };
        return { usd: est.usd, model: est.model, resolution: est.resolution, minimum: est.minimumApplied, ...out };
    }
    const adapter = providers.get(gen.provider);
    if (!adapter || typeof adapter.meter !== 'function') return { usd: null, why: `${gen.provider} cannot price a clip` };
    let usage = null;
    try {
        usage = adapter.meter('video', { model: gen.model || undefined, duration_s: secs, duration: secs,
            target_resolution: `${frame.width}x${frame.height}`, width: frame.width, height: frame.height }, null);
    } catch (_) { usage = null; }
    if (!usage) return { usd: null, why: `${gen.provider} could not meter a ${secs}s clip` };
    const p = priceUsage({ provider: gen.provider, capability: 'video', ...usage });
    if (!p || !p.priced) return { usd: null, why: `no rate for ${gen.provider} ${usage.model || ''}`.trim() };
    const r = rateFor(gen.provider, 'video', usage.model) || {};
    return { usd: p.amount_usd, model: usage.model, inferred: !!r.inferred, self_hosted: !!r.self_hosted, ...out };
}

/** The three categories priced for one choice of generators and size. */
function priceWork(work, imageGen, videoGen, raster, takes) {
    const { plateSize, storyboardSize } = require('./image-standard');
    const res = `${raster.width}x${raster.height}`;
    const aspect = work.project.aspect_ratio || '16:9';
    const lines = [];
    const notes = [];

    // Plates: one priced picture per kind, times subjects and views.
    let plateUsd = 0; let plateCount = 0; let platePriced = true;
    if (imageGen.error) { platePriced = false; notes.push(`Plates: ${imageGen.error}.`); }
    for (const kind of Object.keys(DEFAULT_VIEWS)) {
        const n = work.subjects[kind] * work.views[kind];
        if (!n) continue;
        // A location is re-shot from, so it is made at a 2K floor whatever the project says.
        let size = plateSize(kind === 'location' ? '16:9' : '1:1', res);
        if (kind === 'location' && Math.max(size.width, size.height) < 2048) size = plateSize('16:9', '2048x1152');
        const one = imageGen.error ? { usd: null } : priceImage(imageGen, size);
        if (one.usd == null) platePriced = false;
        const usd = (one.usd || 0) * n * takes.plates;
        plateUsd += usd; plateCount += n;
        lines.push({ category: 'plates', kind, subjects: work.subjects[kind], views: work.views[kind], count: n,
            takes: takes.plates, size: `${size.width}x${size.height}`, unit_usd: one.usd, usd: round2(usd),
            model: one.model || imageGen.model, inferred: !!one.inferred, why: one.why || null });
    }

    // Storyboard: one frame per shot.
    const frames = work.clips.length;
    const board = storyboardSize(aspect, res);
    const frame = imageGen.error ? { usd: null } : priceImage(imageGen, board);
    const boardUsd = (frame.usd || 0) * frames * takes.storyboard;
    lines.push({ category: 'storyboard', kind: 'frame', count: frames, takes: takes.storyboard,
        size: `${board.width}x${board.height}`, unit_usd: frame.usd, usd: round2(boardUsd),
        model: frame.model || imageGen.model, inferred: !!frame.inferred, why: frame.why || null });

    // Footage: one clip per shot at its own length (minimum charges apply per clip).
    let footUsd = 0; let footPriced = !videoGen.error; let seconds = 0; let footModel = videoGen.model; let resTier = null;
    let delivered = null; let downgraded = false; let downWhy = null;
    const minimums = [];
    if (videoGen.error) notes.push(`Footage: ${videoGen.error}.`);
    else {
        for (const secs of work.clips) {
            const c = priceClip(videoGen, secs, raster);
            if (c.usd == null) { footPriced = false; notes.push(`Footage: ${c.why}.`); break; }
            footUsd += c.usd * takes.footage;
            seconds += Math.max(1, Math.round(secs));
            footModel = c.model || footModel; resTier = c.resolution || resTier;
            delivered = c.delivered || delivered; if (c.downgraded) { downgraded = true; downWhy = c.why; }
            if (c.minimum) minimums.push(secs);
        }
    }
    if (downgraded) notes.push(`Footage: ${videoGen.provider_label || videoGen.provider} cannot deliver ${res}; it makes ${delivered}, priced as such. Upscaling to the delivery size is not in this figure.`);
    if (minimums.length) notes.push(`${minimums.length} clip(s) are shorter than the model's minimum charge and are billed at the minimum.`);
    lines.push({ category: 'footage', kind: 'clip', count: work.clips.length, seconds, takes: takes.footage,
        size: res, resolution_tier: resTier, delivered, downgraded, downgrade_why: downWhy, usd: round2(footUsd), model: footModel,
        per_second_usd: seconds ? round2(footUsd / takes.footage / seconds) : null });

    const totals = {
        plates: round2(plateUsd), storyboard: round2(boardUsd), footage: round2(footUsd),
    };
    totals.total = round2(totals.plates + totals.storyboard + totals.footage);
    const imgAdapter = !imageGen.error && providers.get(imageGen.provider);
    const ratioOnly = !!(imgAdapter && (!imgAdapter.sizeControl || imgAdapter.sizeControl === 'ratio-only'));
    const ceiling = imgAdapter && Number(imgAdapter.maxImagePixels) > 0 ? Number(imgAdapter.maxImagePixels) : null;
    const overCeiling = !!(ceiling && board.width * board.height > ceiling);
    const imageSmaller = ratioOnly || overCeiling;
    if (ratioOnly) notes.push(`Plates and frames: ${imageGen.provider_label || imageGen.provider} cannot be told a size, so it returns its own (often about 1 megapixel), not ${res}.`);
    else if (overCeiling) notes.push(`Plates and frames: ${imageGen.provider_label || imageGen.provider} makes at most about ${(ceiling / 1e6).toFixed(1)} megapixels, smaller than ${board.width}x${board.height}.`);
    return { lines, totals, priced: { plates: platePriced, storyboard: frame.usd != null, footage: footPriced }, notes,
        delivered: { image: imageSmaller ? 'smaller than asked' : null, video: downgraded ? delivered : null } };
}

/** The model a priced estimate actually used for a capability. */
function pricedModel(p, cap) {
    const l = p.lines.find(x => x.category === (cap === 'image' ? 'storyboard' : 'footage'));
    return l ? l.model || null : null;
}

/**
 * The estimate.
 *
 * @param {string} projectId
 * @param {object} [opts]
 *   image_provider, image_model, video_provider, video_model  try other generators
 *   resolution       a preset id ('1080p', '4k_uhd' …) or WxH; the project's by default
 *   views            { character, location, prop } pictures per subject
 *   takes            { plates, storyboard, footage } attempts per item (default 1)
 *   shot_seconds     average shot length when the film has no shots yet (default 4)
 *   runtime_seconds  the running time, overriding what the screenplay measures
 *   alternatives     false skips pricing every other connected generator
 */
function estimateProduction(projectId, opts = {}) {
    const work = countWork(projectId, opts);
    if (!work) return null;
    const config = require('./provider-config').providerConfigOf(work.project);
    const raster = resolveRaster(opts.resolution, work.project.target_resolution);
    const takes = {};
    for (const c of CATEGORIES) takes[c] = num(opts.takes && opts.takes[c], 1);

    const imageGen = chooseGenerator('image', config, { provider: opts.image_provider, model: opts.image_model });
    const videoGen = chooseGenerator('video', config, { provider: opts.video_provider, model: opts.video_model });
    const priced = priceWork(work, imageGen, videoGen, raster, takes);

    // What the same work costs on every other connected generator, at this size.
    const alternatives = { image: [], video: [] };
    const excluded = [];
    if (opts.alternatives !== false) {
        for (const cap of ['image', 'video']) {
            for (const adapter of providers.list()) {
                if (!(adapter.capabilities || []).includes(cap)) continue;
                // A generator with no key is still priced, and marked: "this one is half the
                // price if you sign up" is part of the decision. A switched-off local gateway
                // is not a choice at all, and says so in `excluded`.
                if (adapter.id === 'gridlight' && !providers.localGatewayEnabled()) {
                    excluded.push({ capability: cap, provider: adapter.id, why: 'the local Gridlight gateway is switched off' });
                    continue;
                }
                const needsKey = !!(adapter.requiresKey && !providers.isProviderConfigured(adapter.id));
                const models = providers.modelIdsFor(adapter, cap) || [null];
                for (const model of models) {
                    const gen = chooseGenerator(cap, config, { provider: adapter.id, model });
                    if (gen.error) continue;
                    const p = priceWork(work, cap === 'image' ? gen : imageGen, cap === 'video' ? gen : videoGen, raster, takes);
                    const usd = cap === 'image' ? round2(p.totals.plates + p.totals.storyboard) : p.totals.footage;
                    const ok = cap === 'image' ? (p.priced.plates && p.priced.storyboard) : p.priced.footage;
                    if (!ok) { excluded.push({ capability: cap, provider: adapter.id, model, why: 'could not be priced from the rate book' }); continue; }
                    alternatives[cap].push({ needs_key: needsKey, provider: adapter.id, provider_label: adapter.label || adapter.id, model,
                        usd, total: p.totals.total, delivers_less: p.delivered[cap],
                        // The model actually priced, so "its default model" is still recognised.
                        current: gen.provider === (cap === 'image' ? imageGen : videoGen).provider
                            && pricedModel(p, cap) === pricedModel(priced, cap) });
                }
            }
            alternatives[cap].sort((a, b) => a.usd - b.usd);
        }
    }

    const { RESOLUTIONS } = require('./project-presets');
    return {
        project_id: projectId,
        free: true,
        resolution: raster,
        project_resolution: work.project.target_resolution || null,
        resolutions: RESOLUTIONS.filter(r => !/vertical|imax/.test(r.id)).map(r => ({ id: r.id, label: r.label })),
        generators: { image: imageGen, video: videoGen },
        counts: {
            characters: work.subjects.character, locations: work.subjects.location, props: work.subjects.prop,
            views: work.views, shots: work.shots, frames: work.clips.length,
            footage_seconds: round2(work.clips.reduce((n, s) => n + s, 0)),
            shot_source: work.shot_source, shot_seconds: work.shot_seconds,
        },
        runtime: work.runtime,
        takes,
        lines: priced.lines,
        totals: priced.totals,
        priced: priced.priced,
        alternatives,
        excluded,
        notes: [
            ...priced.notes,
            'First attempts at published list rates. Raise "takes" for the regenerations you expect; a refused generation is not billed.',
            'Plates, frames and footage only: voice, music, effects and upscaling are not in this figure.',
        ],
    };
}

module.exports = { estimateProduction, countWork, chooseGenerator, priceImage, priceClip, resolveRaster,
    DEFAULT_VIEWS, DEFAULT_SHOT_SECONDS, CATEGORIES };
