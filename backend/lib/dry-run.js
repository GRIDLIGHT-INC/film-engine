/**
 * WHAT WOULD BE SENT, WITHOUT SENDING IT.
 *
 * "I want to understand what is sent when we generate things."
 *
 * Every paid path already has a free preview, but each answers for one shot on
 * one surface. There was no way to ask the whole question at once: which
 * services a production actually uses, what each request is composed FROM, and
 * what the provider would really receive.
 *
 * Two rules make this worth trusting:
 *
 *   NOTHING IS RE-IMPLEMENTED. The payload comes from buildCapabilityPayload —
 *   the single construction path the routes and the orchestrator both use — and
 *   the outbound body from each adapter's OWN request builder. A report that
 *   described requests it had assembled itself would drift from the ones that
 *   are sent, which is the exact fault the refine preview shipped once.
 *
 *   NOTHING LEAVES. No socket is opened and no credential is read into the
 *   output. Image bytes are described rather than printed: a reference is
 *   multiple megabytes of base64, and a report nobody can read is one nobody
 *   checks.
 */

const { CAPABILITIES } = require('./providers/base');

/** Each adapter's own builder, so the report shows the real request. */
const REQUEST_BUILDERS = {
    google: m => ({ image: m.buildImageRequest }),
    bfl: m => ({ image: m.buildImageRequest }),
    meshy: m => ({ image: m.buildImageRequest }),
    openai: m => ({ image: m.buildImageRequest, llm: m.buildLLMRequest }),
    runway: m => ({ image: m.buildImageRequest, video: m.buildVideoRequest }),
    seedance: m => ({ video: m.buildVideoRequest }),
    elevenlabs: m => ({
        voice: m.buildVoiceRequest, sfx: m.buildSfxRequest,
        music: m.buildMusicRequest, ambient: m.buildAmbientRequest,
    }),
    anthropic: m => ({ llm: m.buildMessagesRequest }),
    gridlight: () => ({}),
};

const MODULE_FOR = {
    google: 'google-image', bfl: 'bfl-image', openai: 'openai-image',
    meshy: 'meshy', runway: 'runway', seedance: 'seedance',
    elevenlabs: 'elevenlabs', anthropic: 'anthropic', gridlight: 'gridlight-adapter',
};

function builderFor(providerId, capability) {
    try {
        const mod = require(`./providers/${MODULE_FOR[providerId]}`);
        const map = (REQUEST_BUILDERS[providerId] || (() => ({})))(mod);
        return typeof map[capability] === 'function' ? map[capability] : null;
    } catch (_) { return null; }
}

/**
 * A picture is described, never printed.
 *
 * One reference is megabytes of base64. Printing them makes the report
 * unreadable, and an unreadable report is one nobody checks — which is the
 * whole point of having it.
 */
function sanitize(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') {
        const m = /^data:([^;,]+);base64,(.*)$/i.exec(value);
        if (m) return `«${m[1]}, ${Math.round(m[2].length * 0.75 / 1024)}KB inline»`;
        /*
         * BARE base64, with no data: prefix.
         *
         * Runway's builder emits the picture as a plain base64 string, so the
         * data-URI check missed it and three thousand characters of image went
         * into the report. A report nobody can read is one nobody checks, which
         * is the entire point of having it.
         */
        if (value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 512))) {
            return `«base64 image, ${Math.round(value.length * 0.75 / 1024)}KB inline»`;
        }
        if (value.length > 600) return `${value.slice(0, 600)}… «${value.length} chars total»`;
        return value;
    }
    if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
    if (typeof value === 'object') {
        if (Buffer.isBuffer(value)) return `«${value.length} bytes»`;
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (/api[_-]?key|authorization|secret|token/i.test(k)) { out[k] = '«redacted»'; continue; }
            out[k] = sanitize(v, depth + 1);
        }
        return out;
    }
    return value;
}

/**
 * What this request was BUILT FROM.
 *
 * The payload alone says what goes; it does not say why. A director reading
 * "the street is wrong" needs to know whether a location plate travelled, not
 * only that some references did.
 */
function inputsFor(capability, ctx, payload) {
    const bits = [];
    const p = payload || {};
    const c = ctx || {};

    if (c.sceneCard) {
        const card = c.sceneCard;
        if (card.description) bits.push(`scene card description (${String(card.description).length} chars)`);
        if (card.direction) bits.push(`director's direction (${String(card.direction).length} chars)`);
        if (card.camera && Object.keys(card.camera).length) {
            bits.push(`camera facets: ${Object.keys(card.camera).join(', ')}`);
        }
        if (Array.isArray(card.dialogue) && card.dialogue.length) {
            bits.push(`${card.dialogue.length} dialogue line(s)`);
        }
    }
    if (c.project && c.project.style_preset) {
        bits.push(`project style preset (${String(c.project.style_preset).length} chars)`);
    }
    if (c.previs) bits.push('previs blocking (staged camera + subjects)');
    if (c.location) bits.push(`location: ${c.location.name}`);
    if (Array.isArray(c.characters) && c.characters.length) {
        bits.push(`characters: ${c.characters.map(x => x.name).join(', ')}`);
    }
    if (c.anchor || c.anchorTag) bits.push('scene anchor frame');
    if (c.keyframeAsset) bits.push('the shot’s storyboard keyframe');
    if (c.videoAsset) bits.push('the shot’s rendered clip');
    if (c.audioAsset) bits.push('the shot’s dialogue track');

    const refs = p.reference_images || p.keyframes || [];
    if (Array.isArray(refs) && refs.length) {
        bits.push(`${refs.length} reference picture(s): `
            + refs.map(r => (r && (r.name || r.tag || r.kind)) || 'unnamed').join(', '));
    }
    if (p.init_image) bits.push('an init image');
    if (p.negative_prompt) bits.push(`a negative prompt (${String(p.negative_prompt).length} chars)`);
    return bits;
}

/** The rate book's answer, never a live call. */
function costFor(providerId, capability, model, payload) {
    try {
        const { rateFor } = require('./provider-pricing');
        const rate = rateFor(providerId, capability, model);
        if (!rate) return null;
        const usd = rate.usd_per_unit !== undefined ? rate.usd_per_unit : rate.usd_per_native;
        const seconds = Number((payload || {}).duration_s || (payload || {}).duration) || null;
        const qty = rate.unit === 'second' && seconds ? seconds : 1;
        return {
            unit: rate.unit,
            native_unit: rate.native_unit,
            per_unit_usd: usd,
            estimate_usd: Number((usd * qty).toFixed(4)),
            basis: rate.unit === 'second' && seconds ? `${seconds}s` : `1 ${rate.unit}`,
            subscription: !!rate.subscription,
            self_hosted: !!rate.self_hosted,
            source: rate.source,
        };
    } catch (_) { return null; }
}

/**
 * One capability, described end to end.
 *
 * `ctx` is whatever loadShotContext / loadSceneContext produced; this function
 * opens nothing and reads no credential.
 */
function describeCapability(capability, ctx, providerConfig) {
    const providers = require('./providers');
    const out = { capability, provider: null, model: null, inputs: [], payload: null,
        outbound: null, cost: null, notes: [] };

    /*
     * The LLM is not a payload this engine builds.
     *
     * Reasoning happens in the connected agent host — that is what lets the
     * pipeline reach a model with no API key of its own — so there is no
     * request to describe here, and reporting "no payload builder" would read
     * as something broken rather than as the architecture.
     */
    if (capability === 'llm') {
        out.provider = providers.resolveId('llm', providerConfig || {}) || 'the MCP host';
        out.notes.push('Reasoning runs in the connected MCP host (Claude Desktop), not through a '
            + 'request this engine builds. It consumes your plan window and charges the project '
            + 'nothing. The server-side adapter is only used by the few HTTP routes that predate MCP.');
        try { out.cost = costFor('anthropic', 'llm', null, {}); } catch (_) { /* unpriced */ }
        return out;
    }


    const id = providers.resolveId(capability, providerConfig || {});
    if (!id) {
        out.notes.push('Nothing is configured to generate this. No request would be built at all.');
        return out;
    }
    out.provider = id;

    /*
     * 3D is not in capability-payloads: meshes are built by lib/threed-prompt
     * from a SUBJECT rather than from a shot, so the report follows it there
     * rather than declaring the capability unbuildable.
     */
    if (capability === 'model3d') {
        try {
            const { build3DPayload, normalizeSubject } = require('./threed-prompt');
            const subject = (ctx && ctx.characters && ctx.characters[0])
                || (ctx && ctx.location) || null;
            if (!subject) {
                out.notes.push('No character, location or prop on this shot to build a mesh from.');
                return out;
            }
            const p3 = build3DPayload(normalizeSubject(subject, subject.name ? 'character' : 'location'));
            out.inputs = [`subject: ${subject.name}`,
                subject.appearance_prompt || subject.description
                    ? 'its written description' : 'its name only — no description to work from'];
            out.payload = sanitize(p3);
            out.model = p3 && p3.model ? p3.model : null;
            out.cost = costFor(id, capability, out.model, p3);
            out.notes.push('Built from the SUBJECT, not the shot: a mesh belongs to a character or '
                + 'a place rather than to one frame.');
        } catch (err) {
            out.notes.push(`Could not build a mesh payload: ${err.message}`);
        }
        return out;
    }

    let payload = null;
    try {
        const { buildCapabilityPayload } = require('./capability-payloads');
        const built = buildCapabilityPayload(capability, ctx || {});
        payload = Array.isArray(built.payload) ? built.payload[0] : built.payload;
        if (Array.isArray(built.payload)) {
            /*
             * ZERO is a real answer, and the interesting one.
             *
             * voice and sfx are one-context-to-MANY: a shot with no dialogue
             * produces no voice request at all. Reported as an empty list this
             * looked like a builder crash — "cannot read properties of
             * undefined" — which is a fault in the report rather than a fact
             * about the shot.
             */
            out.request_count = built.payload.length;
            if (!built.payload.length) {
                out.notes.push(capability === 'voice'
                    ? 'This shot has no dialogue, so NO voice request would be sent.'
                    : 'This shot names no cues, so NO request would be sent.');
                out.cost = null;
                return out;
            }
            if (built.payload.length > 1) {
                out.notes.push(`${built.payload.length} requests would be sent — one per `
                    + (capability === 'voice' ? 'dialogue line' : 'cue') + '; the first is shown.');
            }
        }
    } catch (err) {
        // PRECONDITION means a real prerequisite is absent, which is a fact
        // about this shot rather than a fault in the report.
        out.notes.push(err.code === 'PRECONDITION'
            ? `Cannot be built yet: ${err.message}`
            : `Payload could not be built: ${err.message}`);
        return out;
    }

    const adapter = providers.get(id);
    try {
        const { withTierModel } = require('./capability-payloads');
        if (capability === 'image') withTierModel(payload, ctx, adapter);
    } catch (_) { /* the tier is a nicety here */ }
    out.model = payload && payload.model ? payload.model : null;

    out.inputs = inputsFor(capability, ctx, payload);
    out.payload = sanitize(payload);

    const build = builderFor(id, capability);
    if (build) {
        try {
            const req = build(payload);
            out.outbound = sanitize(req && req.body ? { url: req.url, body: req.body } : req);
            if (req && req.body && req.body.model) out.model = req.body.model;
        } catch (err) {
            out.notes.push(`This provider's request builder refused: ${err.message}`);
        }
    } else {
        out.notes.push('This adapter exposes no request builder, so the payload above is '
            + 'what it receives rather than the exact wire body.');
    }

    out.cost = costFor(id, capability, out.model, payload);
    return out;
}

module.exports = { describeCapability, sanitize, inputsFor, costFor, CAPABILITIES };
