/**
 * World Labs Marble — spatial world reconstruction.
 *
 * Marble owns ENVIRONMENT RECONSTRUCTION and nothing else. Film Engine owns
 * filmmaking semantics; the image and video models own final visual generation.
 * Blurring those is how a previs tool becomes a bad 3D editor.
 *
 * Verified against the live API rather than the docs alone: a draft world from
 * two generated location plates came back in 37 seconds for 250 credits, and
 * its collider mesh parsed with this engine's existing `glb-parser` at 53,841
 * triangles across 39.6 x 9.0 x 47.9 world units.
 *
 * ASYNC, LIKE MESHY. Generation is an operation polled to completion, so the id
 * is written through `onHandle` BEFORE polling starts — a world abandoned by
 * the host is collectable rather than lost, which is the rule every polling
 * adapter here follows.
 */

const DEFAULT_BASE_URL = 'https://api.worldlabs.ai';
const POLL_TIMEOUT_MS = 900000;                 // 15 min; a world is ~40s-5min

/**
 * Draft is the previs model and the default ON PURPOSE.
 *
 * 250 credits against 1,600 is not a quality preference, it is what makes
 * camera exploration affordable: measured here, a draft world costs $0.20 and a
 * single storyboard frame costs about $0.15. Iterate on drafts, generate the
 * good one once the geometry is useful.
 */
const MODELS = Object.freeze({
    'marble-1.0-draft': { label: 'Draft', credits: 250, what: 'fast, cheap, for exploring geometry' },
    'marble-1.0': { label: 'Standard (1.0)', credits: 1600, what: 'full world' },
    'marble-1.1': { label: 'Standard', credits: 1600, what: 'full world, current' },
    'marble-1.1-plus': { label: 'Large', credits: 3100, what: 'larger interiors and exteriors' },
});
const DEFAULT_MODEL = 'marble-1.0-draft';

/**
 * Compass side to Marble azimuth.
 *
 * Direction Control takes up to four images, each tagged with an azimuth
 * documented as 0/90/180/270 = front/right/back/left. This engine's compass
 * sweep produces exactly four direction-named plates of one location, for the
 * same reason Marble wants them: a plate carries no information about what is
 * behind its own camera. North is the plate the others turn from, so north is
 * front. Reversed, every world would be built facing the wrong way and nothing
 * downstream would say so.
 */
const AZIMUTH = Object.freeze({ north: 0, east: 90, south: 180, west: 270, '': 0 });

/**
 * What `is_pano` may be, from the provider's own refusal rather than the docs.
 *
 * Marble answers "Input should be 'auto', True or False", recorded by ICP-004
 * in backend/tests/fixtures/marble-contract.json and re-derivable for nothing
 * with `node backend/tests/refresh-marble-contract.js`. It is declared here
 * because it is a fact about Marble, in the same place `MAX_INPUT_IMAGES` and
 * the model list live — a picker built from a guess offers values the provider
 * refuses.
 */
const PANO_VALUES = Object.freeze(['auto', true, false]);

/**
 * A caller's is_pano, or the default.
 *
 * `p.is_pano || 'auto'` was the old line and it could never say FALSE: false is
 * falsy, so an explicit "read this as a flat frame, not a panorama" collapsed
 * back to auto and looked like the feature working. Undefined is the only thing
 * that means "no opinion".
 */
function panoFor(value) {
    if (value === undefined || value === null) return 'auto';
    if (!PANO_VALUES.includes(value)) {
        throw new Error(`is_pano must be one of ${PANO_VALUES.map(v => JSON.stringify(v)).join(', ')}`
            + ` — Marble refuses anything else. Got ${JSON.stringify(value)}.`);
    }
    return value;
}

/** Documented input ceiling: Direction Control accepts at most four images. */
const MAX_INPUT_IMAGES = 4;

function baseUrl() {
    return (process.env.WORLDLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function mediaRef(src) {
    if (src && src.uri) return { source: 'uri', uri: src.uri };
    if (src && src.data) {
        return {
            source: 'data_base64',
            data_base64: Buffer.isBuffer(src.data) ? src.data.toString('base64') : String(src.data),
            extension: (src.extension || 'png').replace(/^\./, ''),
        };
    }
    return null;
}

/** Build the documented `world_prompt`, choosing the shape from what is given. */
function buildWorldPrompt(payload) {
    const p = payload || {};
    const images = (p.images || []).map(i => ({ ...i, ref: mediaRef(i) })).filter(i => i.ref);

    if (images.length > 1) {
        return {
            prompt: {
                type: 'multi-image',
                multi_image_prompt: images.slice(0, MAX_INPUT_IMAGES).map(i => ({
                    azimuth: Number.isFinite(i.azimuth) ? i.azimuth : (AZIMUTH[i.view] ?? 0),
                    content: i.ref,
                })),
                ...(p.prompt ? { text_prompt: String(p.prompt) } : {}),
            },
            // Never dropped silently: over-sending is a refusal that costs a request.
            dropped: Math.max(0, images.length - MAX_INPUT_IMAGES),
        };
    }
    /*
     * VIDEO is the fourth documented type and the only one that is not built
     * from plates. Its field name is world_prompt.video.video_prompt —
     * VERIFIED against the live API and RECORDED, not asserted: see
     * backend/tests/fixtures/marble-contract.json, re-derivable for free with
     * `node backend/tests/refresh-marble-contract.js`. The comment here used to
     * claim the name came from a 422 and wrote nothing down, which is the same
     * shape as an unsourced price: true on the day and unre-checkable after it.
     *
     * It is checked BEFORE the single-image branch on purpose — a caller that
     * supplies footage means the walkthrough, not one frame of it.
     */
    const video = p.video ? mediaRef(p.video) : null;
    if (video) {
        return {
            prompt: {
                type: 'video', video_prompt: video,
                ...(p.prompt ? { text_prompt: String(p.prompt) } : {}),
            },
            dropped: 0,
        };
    }
    if (images.length === 1) {
        return {
            prompt: {
                // is_pano is a real field, not one Marble ignores: probed with a
                // value that cannot coerce, it answers "Input should be 'auto',
                // True or False". An int probe validated by coercion and made it
                // look absent — the reason the contract records the domain.
                type: 'image', image_prompt: images[0].ref, is_pano: panoFor(p.is_pano),
                ...(p.prompt ? { text_prompt: String(p.prompt) } : {}),
            },
            dropped: 0,
        };
    }
    if (p.prompt) return { prompt: { type: 'text', text_prompt: String(p.prompt) }, dropped: 0 };
    return { prompt: null, dropped: 0 };
}

function buildRequest(payload) {
    const p = payload || {};
    const model = MODELS[p.model] ? p.model : DEFAULT_MODEL;
    const { prompt, dropped } = buildWorldPrompt(p);
    return {
        url: `${baseUrl()}/marble/v1/worlds:generate`,
        body: {
            world_prompt: prompt,
            model,
            ...(p.display_name ? { display_name: String(p.display_name).slice(0, 64) } : {}),
            ...(Number.isInteger(p.seed) ? { seed: p.seed } : {}),
        },
        model,
        dropped_images: dropped,
    };
}

async function generate(capability, payload, opts) {
    if (capability !== 'world') {
        return { ok: false, status: 400, error: `worldlabs does not serve '${capability}'` };
    }
    const { getCredential } = require('./credentials');
    const cred = getCredential('worldlabs');
    const apiKey = process.env.WORLDLABS_API_KEY || (cred && (cred.apiKey || cred));
    if (!apiKey || typeof apiKey !== 'string') {
        return { ok: false, status: 401, error: 'worldlabs: no API key. Add one in Setup.' };
    }

    const request = buildRequest(payload);
    if (!request.body.world_prompt) {
        return { ok: false, status: 400, error: 'worldlabs: nothing to build a world from' };
    }

    const headers = { 'Content-Type': 'application/json', 'WLT-Api-Key': apiKey };
    let op;
    try {
        const res = await fetch(request.url, { method: 'POST', headers, body: JSON.stringify(request.body) });
        const text = await res.text();
        try { op = JSON.parse(text); } catch (_) { op = { error: { message: text.slice(0, 300) } }; }
        if (!res.ok) return { ok: false, status: res.status, error: `worldlabs ${res.status}: ${(op.error && op.error.message) || text.slice(0, 200)}` };
    } catch (err) {
        return { ok: false, status: 502, error: `worldlabs: ${err.message}` };
    }

    // Written down BEFORE polling: a world the host abandons is collectable.
    if (opts && typeof opts.onHandle === 'function') {
        try { opts.onHandle(op.operation_id, { operation: 'world', model: request.model }); } catch (_) { /* never blocks a paid call */ }
    }

    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    const started = Date.now();
    while (!op.done) {
        if (Date.now() - started > budget) {
            return {
                ok: false, status: 504, pending: true, handle: op.operation_id,
                error: `worldlabs: still generating after ${Math.round(budget / 1000)}s. `
                     + 'It is not lost — collect it with the operation id.',
            };
        }
        const waited = (Date.now() - started) / 1000;
        const fixed = Number(process.env.WORLDLABS_POLL_MS) || 0;
        await new Promise(r => setTimeout(r, fixed || (waited < 30 ? 3000 : waited < 120 ? 5000 : 10000)));
        try {
            const res = await fetch(`${baseUrl()}/marble/v1/operations/${op.operation_id}`, { headers });
            op = await res.json();
            if (!op.done) {
                const { emit, pollPercent } = require('../generation-progress');
                emit(opts, { percent: pollPercent(op), phase: 'building world' });
            }
        } catch (err) {
            return { ok: false, status: 502, error: `worldlabs poll: ${err.message}` };
        }
    }
    if (op.error && op.error.message) {
        return { ok: false, status: 500, error: `worldlabs: ${op.error.message}` };
    }

    const world = op.response || {};
    const assets = world.assets || {};
    return {
        ok: true, status: 200,
        data: world,
        provider: 'worldlabs',
        provider_model: request.model,
        provider_job_id: op.operation_id,
        world: {
            id: world.world_id,
            collider_mesh_url: (assets.mesh && assets.mesh.collider_mesh_url) || null,
            splat_urls: (assets.splats && assets.splats.spz_urls) || {},
            panorama_url: (assets.imagery && assets.imagery.pano_url) || null,
            thumbnail_url: assets.thumbnail_url || null,
            caption: assets.caption || '',
        },
        usage: {
            unit: 'world', quantity: 1,
            native_unit: 'credit',
            native_quantity: (op.cost && op.cost.total_credits) || MODELS[request.model].credits,
        },
        meta: { dropped_images: request.dropped_images },
    };
}

/**
 * Meter one world.
 *
 * The billed figure is the one the OPERATION reports, never the price list:
 * draft is documented as 150-250 credits "depending on input type", so a rate
 * table alone would under- or over-report by up to 40% on every generation. The
 * table is only the fallback for a response that carries no cost.
 */
function meterWorldLabs(capability, payload, result) {
    if (capability !== 'world') return null;
    const model = (result && result.provider_model) || (payload && payload.model) || DEFAULT_MODEL;
    const billed = result && result.usage && Number(result.usage.native_quantity);
    return {
        unit: 'call', quantity: 1, model,
        native_unit: 'credit',
        native_quantity: billed > 0 ? billed : (MODELS[model] || MODELS[DEFAULT_MODEL]).credits,
    };
}

const adapter = {
    id: 'worldlabs',
    name: 'World Labs Marble',
    capabilities: ['world'],
    /*
     * Part of the adapter contract base.js documents, and DERIVED from the
     * array above rather than written out — two answers to "do you serve this"
     * is how an adapter comes to be preferred for a capability it refuses.
     * Omitting it entirely was worse: `providers.get(id).supports(cap)` is what
     * the readiness check calls, so the preference table reported this adapter
     * as not serving the one capability it exists for.
     */
    supports(capability) { return this.capabilities.includes(capability); },
    requiresKey: true,
    // Polls an operation to completion, so the handle is written before polling
    // and a host teardown leaves the world collectable rather than lost.
    asyncGeneration: true,
    /** No cancel this adapter can perform: "stop waiting" leaves the job collectable (PGN-012). */
    cancel: 'stop_waiting',
    /** Marble's operation reports done or not; a percentage only if its metadata carries one. */
    reportsProgress: 'phase',
    envVar: 'WORLDLABS_API_KEY',
    docsUrl: 'https://platform.worldlabs.ai',
    connection: {
        instructions: 'Spatial worlds for previs. Get a key at platform.worldlabs.ai — $5 is '
            + '6,250 credits, and a draft world costs 250 of them.',
    },
    models: { world: Object.keys(MODELS) },
    defaultModel: DEFAULT_MODEL,
    maxInputImages: MAX_INPUT_IMAGES,
    generate,
    meter: meterWorldLabs,
};

module.exports = { adapter, buildRequest, meterWorldLabs, buildWorldPrompt, MODELS, DEFAULT_MODEL, AZIMUTH, MAX_INPUT_IMAGES, PANO_VALUES, panoFor };
