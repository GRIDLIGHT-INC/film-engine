/**
 * What pressing Generate will cost, worked out locally and before anything runs.
 *
 * Deliberately NOT a call to a provider's estimate endpoint. A local estimate
 * works before you have an account, works when the network does not, and cannot
 * itself fail in a way that blocks the check it exists to provide. The registry
 * already carries every number Runway publishes, so the arithmetic is ours.
 *
 * Three things make an estimate wrong if they are missed, and all three are
 * modelled here because each was found in the published rate card rather than
 * assumed:
 *
 *  1. RESOLUTION changes the rate, and by a lot — Seedance 2.5 is 20 credits a
 *     second at 480p and 68 at 1080p.
 *  2. REFERENCE VIDEO is billed per second, at roughly half the output rate.
 *     Three 5-second reference clips on a 10-second Seedance shot add 225
 *     credits — more than the shot itself. Reference IMAGES are usually free
 *     (Seedance) or nearly so (H3 at 2 credits).
 *  3. MINIMUM CHARGES exist. A 2-second Seedance 2.5 clip bills at its
 *     80-credit floor, so short clips cost more per second than long ones.
 *
 * Credits are $0.01 on Runway. That is the only currency conversion here.
 */
const { RUNWAY_VIDEO_MODELS } = require('./providers/runway');

const USD_PER_CREDIT = 0.01;

/**
 * The billing tier a delivered frame falls in. A model with resolution tiers
 * (Seedance 2.5 480p/720p/1080p, Hailuo 3 768P/2K) bills the tier its ratio
 * renders at, and now that a 1080p project is sent 1920:1080 the estimate has
 * to follow the frame or it quotes 720p for a 1080p clip. The smallest tier
 * whose short edge covers the frame; above them all, the highest — so an
 * estimate never under-counts.
 */
function tierForFrame(model, frame) {
    const m = RUNWAY_VIDEO_MODELS[String(model || '').trim()];
    if (!m || !m.resolutions) return null;
    const f = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(String(frame || ''));
    if (!f) return null;
    const short = Math.min(Number(f[1]), Number(f[2]));
    const edge = label => {
        const k = /^(\d+(?:\.\d+)?)\s*k$/i.exec(label);
        if (k) return Math.round(Number(k[1]) * 1024 * 9 / 16);
        const p = /^(\d+)\s*p$/i.exec(label);
        return p ? Number(p[1]) : 0;
    };
    const tiers = Object.keys(m.resolutions).map(l => ({ l, e: edge(l) })).sort((a, b) => a.e - b.e);
    const fit = tiers.find(t => t.e >= short);
    return (fit || tiers[tiers.length - 1]).l;
}

/** The rate card for a model at a resolution, falling back to its base rate. */
function ratesFor(model, resolution) {
    const m = RUNWAY_VIDEO_MODELS[String(model || '').trim()];
    if (!m) return null;
    const label = String(resolution || m.defaultResolution || '').trim();
    const tier = (m.resolutions && (m.resolutions[label] || m.resolutions[m.defaultResolution])) || {};
    return {
        model: m,
        resolution: label || null,
        creditsPerSecond: tier.creditsPerSecond ?? m.creditsPerSecond ?? 0,
        imageReferenceCredits: tier.imageReferenceCredits ?? m.imageReferenceCredits ?? 0,
        videoReferenceCreditsPerSecond:
            tier.videoReferenceCreditsPerSecond ?? m.videoReferenceCreditsPerSecond ?? 0,
        audioReferenceCredits: tier.audioReferenceCredits ?? m.audioReferenceCredits ?? 0,
        minimumCredits: tier.minimumCredits ?? m.minimumCredits ?? 0,
        firstFrameCredits: m.firstFrameCredits ?? 0,
    };
}

/**
 * Estimate one generation.
 *
 * Returns the total AND the lines it is made of, because a number with no
 * breakdown cannot be checked — and the line a director most needs to see is
 * the one they did not expect, which is nearly always the reference video.
 */
function estimateVideoCost(opts) {
    const o = opts || {};
    const r = ratesFor(o.model, o.resolution || tierForFrame(o.model, o.frame));
    if (!r) {
        return { model: o.model || null, credits: 0, usd: 0, lines: [],
            unknownModel: true,
            note: `no rate card for "${o.model}" — it is not a model this adapter forwards` };
    }

    const seconds = Number(o.durationSeconds) > 0 ? Number(o.durationSeconds) : 0;
    const images = Math.max(0, Number(o.imageReferences) || 0);
    const audio = Math.max(0, Number(o.audioReferences) || 0);
    const refSeconds = Math.max(0, Number(o.videoReferenceSeconds) || 0);
    const firstFrame = o.firstFrame ? r.firstFrameCredits : 0;

    const lines = [];
    const push = (label, credits, detail) => {
        if (!credits) return;
        lines.push({ label, credits, usd: credits * USD_PER_CREDIT, detail });
    };

    const output = Math.round(seconds * r.creditsPerSecond);
    push(`${seconds}s of video`, output, `${r.creditsPerSecond} credits/second`
        + (r.resolution ? ` at ${r.resolution}` : ''));
    push(`${images} reference image${images === 1 ? '' : 's'}`,
        images * r.imageReferenceCredits, `${r.imageReferenceCredits} credits each`);
    push(`${refSeconds}s of reference video`,
        Math.round(refSeconds * r.videoReferenceCreditsPerSecond),
        `${r.videoReferenceCreditsPerSecond} credits/second — billed like output`);
    push(`${audio} reference audio`, audio * r.audioReferenceCredits,
        `${r.audioReferenceCredits} credits each`);
    push('first frame', firstFrame, `${r.firstFrameCredits} credits`);

    let credits = lines.reduce((sum, l) => sum + l.credits, 0);
    let minimumApplied = false;
    if (r.minimumCredits && credits < r.minimumCredits) {
        // Named, not folded into the total: a short clip costing the same as a
        // longer one is surprising, and a surprise in a bill is a support
        // question.
        lines.push({
            label: `minimum charge for this model`,
            credits: r.minimumCredits - credits,
            usd: (r.minimumCredits - credits) * USD_PER_CREDIT,
            detail: `billed at a floor of ${r.minimumCredits} credits`,
        });
        credits = r.minimumCredits;
        minimumApplied = true;
    }

    return {
        model: o.model,
        resolution: r.resolution,
        durationSeconds: seconds,
        credits,
        usd: credits * USD_PER_CREDIT,
        usdPerCredit: USD_PER_CREDIT,
        minimumApplied,
        lines,
        source: r.model.source,
    };
}

/** Price the same shot across every model, for a comparison a director reads. */
function compareVideoModels(opts) {
    return Object.keys(RUNWAY_VIDEO_MODELS)
        .map(model => estimateVideoCost({ ...(opts || {}), model }))
        .sort((a, b) => a.credits - b.credits);
}

module.exports = { tierForFrame, estimateVideoCost, compareVideoModels, ratesFor, USD_PER_CREDIT };
