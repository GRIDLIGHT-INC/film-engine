/**
 * What a generator costs, side by side.
 *
 * The rate book has carried per-model prices, source URLs and checked dates
 * since metering shipped, and the Budget page rendered them one provider per
 * card — so answering "which should I use for images" meant expanding seven
 * cards and sorting in your head. Worse, the per-model table printed
 * `1 image(s) per image` for every row: the price was served by the route and
 * thrown away by the renderer, so the one table that could compare models
 * showed no money at all.
 *
 * THREE THINGS MAKE A PRICE COMPARABLE, and the rate book alone has none of
 * them:
 *
 *  - A COMMON UNIT. Images bill per image and video bills per second, so
 *    $0.067 and $0.34 are not the same kind of number. Every row is also
 *    priced for one unit of REAL WORK — a frame, a clip — and for a scene of
 *    them, because "cheap per second" and "cheap per shot" rank differently
 *    the moment clip lengths differ.
 *  - WHETHER YOU CAN ACTUALLY USE IT. A price you have no key for is not a
 *    choice. Uncredentialed providers are listed and marked, never hidden:
 *    hiding them answers "which of these should I use" while silently
 *    withholding "and this one is half the price if you sign up".
 *  - WHAT IT IS FOR. Cheapest-wins is the wrong read — draft models exist to
 *    be rolled repeatedly and precision models exist to be right once. Each
 *    row carries the tier it serves and that tier's stated purpose, so cost
 *    sits beside intent rather than replacing it.
 *
 * The denominator is DERIVED from `providers.list()` — every adapter that
 * declares the capability — never a list typed here. A hand list is only as
 * complete as the afternoon it was written, and an adapter added later would
 * be missing from the comparison with nothing failing.
 *
 * Nothing here generates or spends. It reads two registries.
 */

const providers = require('./providers');
const { rateFor } = require('./provider-pricing');
const { IMAGE_TIERS } = require('./quality-tiers');

/** The capabilities a director actually shops for. */
const COMPARABLE = Object.freeze(['image', 'video']);

/*
 * One unit of real work per capability, so the columns are commensurable.
 *
 * A clip is 5s because that is the middle of what the video adapters accept
 * (Runway 2–10s) and what a storyboard shot usually is — not because 5 is
 * round. The scene figure is 10 of them: the number a director is really
 * deciding about is a scene, not a frame, and a $0.05 difference per image is
 * invisible until it is multiplied by the board.
 */
const WORK = Object.freeze({
    image: { work_label: 'one frame', scene_count: 10, scene_label: 'a 10-frame scene' },
    video: { work_label: 'a 5s clip', scene_count: 10, scene_label: 'a 10-shot scene at 5s' },
});

/** Delivery size the megapixel rates are converted against. */
const DEFAULT_FRAME = Object.freeze({ width: 1920, height: 1080 });
const DEFAULT_CLIP_SECONDS = 5;

/**
 * How many BILLED UNITS one unit of work costs.
 *
 * This is the whole point of the module and it is easy to get wrong — I did,
 * first time round. The three image providers do not bill in the same unit:
 * Runway and OpenAI bill per IMAGE, Meshy bills per CALL, and BFL bills per
 * MEGAPIXEL. Treating a megapixel as a frame prices flux-2-pro at $0.030 when
 * a 1920x1080 frame is 2.07 MP and really costs $0.062 — it moved BFL to the
 * top of a table whose entire purpose is ranking, which is worse than not
 * ranking at all.
 *
 * Megapixels therefore depend on the DELIVERY SIZE, so the comparison takes
 * the project's frame rather than assuming one. That is also why the frame is
 * reported back with the table: a per-megapixel row is only as true as the
 * size it was priced at, and a reader who is not told will assume otherwise.
 */
function unitsPerWork(unit, capability, opts) {
    const frame = opts.frame || DEFAULT_FRAME;
    const seconds = Number.isFinite(opts.clip_seconds) && opts.clip_seconds > 0
        ? opts.clip_seconds : DEFAULT_CLIP_SECONDS;

    switch (unit) {
        case 'megapixel': return (frame.width * frame.height) / 1e6;
        case 'second':    return capability === 'video' ? seconds : 1;
        case 'image':
        case 'call':      return 1;
        default:
            // An unrecognised unit is priced as one-per-work and SAID, rather
            // than silently scaled by a number nobody chose.
            return 1;
    }
}

/**
 * Which tier, if any, routes to this exact (provider, model).
 *
 * Matched on the tier's explicit model mapping rather than on its `order`
 * walk: being in the walk means "this tier would fall back to you", which is
 * a different claim from "this is what this tier is", and labelling every
 * provider in every walk would tag most rows with all three tiers.
 */
function tierFor(capability, providerId, model) {
    if (capability !== 'image') return null;
    for (const [id, tier] of Object.entries(IMAGE_TIERS || {})) {
        if ((tier.models || {})[providerId] === model) {
            return { id, label: tier.label || id, why: tier.why || null };
        }
    }
    return null;
}

/** Whole days between a checked date and now. Null if unparseable. */
function ageDays(checked, now) {
    if (!checked) return null;
    const then = Date.parse(checked + 'T00:00:00Z');
    if (!Number.isFinite(then)) return null;
    return Math.max(0, Math.floor((now - then) / 86400000));
}

/**
 * Every (provider, model) that can serve `capability`, priced.
 *
 * @param {string} capability   'image' | 'video'
 * @param {object} [opts]
 * @param {number} [opts.now]           epoch ms, for the checked-age column
 * @param {number} [opts.clip_seconds]  override the work unit for video
 * @returns {{capability, work, rows, unpriced, note}}
 */
function compareGenerators(capability, opts = {}) {
    if (!COMPARABLE.includes(capability)) {
        const err = new Error(`compareGenerators: '${capability}' is not a shoppable capability `
            + `(expected one of ${COMPARABLE.join(', ')})`);
        err.code = 'BAD_CAPABILITY';
        throw err;
    }

    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const frame = opts.frame || DEFAULT_FRAME;
    const seconds = Number.isFinite(opts.clip_seconds) && opts.clip_seconds > 0
        ? opts.clip_seconds : DEFAULT_CLIP_SECONDS;

    const work = { ...WORK[capability], frame, clip_seconds: seconds };
    if (capability === 'video') {
        work.work_label = `a ${seconds}s clip`;
        work.scene_label = `a ${work.scene_count}-shot scene at ${seconds}s`;
    } else {
        work.work_label = `one ${frame.width}x${frame.height} frame`;
    }

    const rows = [];
    const unpriced = [];

    // DERIVED: every adapter declaring the capability, never a typed list.
    for (const adapter of providers.list()) {
        if (!(adapter.capabilities || []).includes(capability)) continue;

        const base = rateFor(adapter.id, capability);
        if (!base) {
            // An adapter that can generate and cannot be priced would silently
            // report as free. Named rather than skipped.
            unpriced.push({ provider: adapter.id, capability,
                why: 'no entry in the rate book — generations would be metered but priced at nothing' });
            continue;
        }

        const credentialed = providers.isProviderConfigured(adapter.id);
        const checked = base.checked || null;

        // A provider with no per-model breakdown still gets one row, from its
        // own default rate — otherwise it vanishes from the comparison.
        const models = base.models && Object.keys(base.models).length
            ? Object.keys(base.models)
            : [null];

        for (const model of models) {
            const r = rateFor(adapter.id, capability, model) || base;
            const usdPerUnit = Number(r.usd_per_unit ?? r.usd_per_native ?? 0);
            const unit = r.unit || base.unit || 'call';
            const units = unitsPerWork(unit, capability, { frame, clip_seconds: seconds });

            rows.push({
                provider: adapter.id,
                provider_label: adapter.label || adapter.id,
                model: model || '(default)',
                unit,
                units_per_work: units,
                usd_per_unit: usdPerUnit,
                usd_per_work: usdPerUnit * units,
                usd_per_scene: usdPerUnit * units * work.scene_count,

                // "free" and "we have no price" are different claims and look
                // identical as 0. Documented in the spend work; kept explicit.
                self_hosted: !!r.self_hosted,
                inferred: !!r.inferred,

                credentialed,
                available: credentialed || !adapter.requiresKey,
                needs: credentialed || !adapter.requiresKey ? null
                    : `no credential for ${adapter.label || adapter.id}`,

                /*
                 * Whether this provider can be TOLD a size.
                 *
                 * Measured from a real file: a plate came back 1376x768 on a
                 * project set to 2048x1080, because Meshy's text-to-image has
                 * no width, height or size field and a requested resolution
                 * can only become an aspect ratio. That is invisible from
                 * cost alone and changes which generator you should pick, so
                 * it belongs beside the price.
                 */
                size_control: adapter.sizeControl || 'ratio-only',
                honours_resolution: !!adapter.sizeControl && adapter.sizeControl !== 'ratio-only',
                size_note: adapter.sizeControlReason || null,
                /*
                 * Per MODEL where the adapter can say. Google's draft model is
                 * 1K only while its other two reach 4K, so "this provider does
                 * 2K" is true of the provider and false of the model the draft
                 * tier would actually run — the same over-promise one level
                 * down.
                 */
                max_size: (model && typeof adapter.maxSizeForModel === 'function')
                    ? adapter.maxSizeForModel(model) : null,

                tier: tierFor(capability, adapter.id, model),
                source: r.source || base.source || null,
                checked,
                checked_age_days: ageDays(checked, now),
                note: r.note || base.note || null,
            });
        }
    }

    /*
     * Cheapest first, but a self-hosted zero does NOT lead the table: it is
     * zero because nobody bills for it, not because it is a bargain, and
     * putting it at the top reads as a recommendation. It sorts last with its
     * reason attached.
     */
    rows.sort((a, b) => {
        if (a.self_hosted !== b.self_hosted) return a.self_hosted ? 1 : -1;
        return a.usd_per_work - b.usd_per_work;
    });

    return {
        capability,
        work,
        rows,
        unpriced,
        note: 'Prices are the providers\' published list rates on the dates shown, for a '
            + 'first attempt. A refused generation is not billed, and the image chain walks '
            + 'past a provider that declines — so a frame can cost more than one row here.',
    };
}

module.exports = { compareGenerators, COMPARABLE, WORK, tierFor, ageDays,
    unitsPerWork, DEFAULT_FRAME, DEFAULT_CLIP_SECONDS };
