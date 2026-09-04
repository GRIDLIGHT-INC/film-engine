/**
 * Generator nodes — all ten of them, one implementation.
 *
 * The capability is DATA on the node type, so gen.image and gen.lipsync differ
 * only in a string. That is the same insight that already makes
 * routes/pipeline.js:executeStep four lines long, and it is what delivers the
 * "multi-model" headline for free: a per-node provider override is just a
 * different config object at the resolve() call.
 *
 * Payloads come from lib/capability-payloads.js — the Phase 0 module — so a
 * node, a route and the legacy orchestrator cannot describe the same
 * generation differently.
 */

const { PORT } = require('./port');
const { nodeType } = require('../flow-node-types');
const { buildCapabilityPayload, providerConfigOf } = require('../capability-payloads');

// Which port a capability's result leaves on.
const OUTPUT_PORT = {
    llm: 'text', image: 'image', video: 'video', voice: 'audio',
    music: 'audio', sfx: 'audio', ambient: 'audio', lipsync: 'video',
    post: 'video', model3d: 'model3d',
};

/** First value on a port, whether it arrived alone or in a collector array. */
function firstValue(portValue) {
    if (!portValue) return null;
    return Array.isArray(portValue) ? (portValue[0] && portValue[0].value) : portValue.value;
}

/**
 * Fold wired inputs into the context the payload builder reads.
 *
 * An upstream prompt must win over the scene card: wiring a prompt into a node
 * and having it silently ignored is the single most confusing thing a canvas
 * can do.
 */
function contextFromInputs(ctx, inputs, node) {
    const merged = { ...ctx, overrides: { ...(ctx.overrides || {}), ...((node.config || {}).overrides || {}) } };
    const config = node.config || {};

    const text = firstValue(inputs.text);
    if (text) {
        merged.sceneCard = { ...(merged.sceneCard || {}), action: text };
        merged.promptOverride = text;
    }

    const image = firstValue(inputs.image);
    if (image) merged.initImage = image.base64 || image.path || image;

    const video = firstValue(inputs.video);
    if (video) merged.videoAsset = video.assetId ? { id: video.assetId, file_path: video.path, file_name: video.file_name } : merged.videoAsset;

    const audio = firstValue(inputs.audio);
    if (audio) merged.audioAsset = audio.assetId ? { id: audio.assetId, file_path: audio.path, file_name: audio.file_name } : merged.audioAsset;

    const subject = firstValue(inputs.subject);
    if (subject && subject.consistency) merged.consistency = subject.consistency;

    // Per-node model/seed/provider choice.
    if (config.model) merged.overrides.model = config.model;
    if (config.seed !== undefined) merged.overrides.seed = config.seed;
    if (config.job_type) merged.overrides.job_type = config.job_type;

    return merged;
}

/** Apply an upstream prompt to whatever field the built payload uses for it. */
function applyPromptOverride(payload, promptOverride) {
    if (!promptOverride) return payload;
    const one = p => {
        if (!p || typeof p !== 'object') return p;
        if (typeof p.prompt === 'string') return { ...p, prompt: `${promptOverride}${p.prompt ? ', ' + p.prompt : ''}` };
        if (typeof p.text === 'string') return { ...p, text: promptOverride };
        return p;
    };
    return Array.isArray(payload) ? payload.map(one) : one(payload);
}

async function executeGenerator(node, inputs, ctx) {
    const def = nodeType(node.type);
    const capability = def && def.capability;
    if (!capability) return { ok: false, error: `node type '${node.type}' declares no capability` };

    const merged = contextFromInputs(ctx, inputs || {}, node);

    let built;
    try {
        built = buildCapabilityPayload(capability, merged);
    } catch (err) {
        // A missing upstream artefact is work that is not ready, not a failure
        // to retry — the same distinction the orchestrator draws.
        if (err.code === 'PRECONDITION') {
            return { ok: true, skipped: true, message: err.message, outputs: {} };
        }
        return { ok: false, error: `could not build ${capability} payload: ${err.message}` };
    }

    const payload = applyPromptOverride(built.payload, merged.promptOverride);
    const requests = Array.isArray(payload) ? payload : [payload];
    if (requests.length === 0) {
        return { ok: true, skipped: true, message: `no ${capability} work for this node`, outputs: {} };
    }

    // Per-node provider override layered over the project's configuration.
    const projectConfig = { ...providerConfigOf(ctx.project) };
    if (node.config && node.config.provider) projectConfig[capability] = node.config.provider;

    const provider = ctx.providerFor
        ? ctx.providerFor(capability, projectConfig)
        : require('../providers').resolveGenerator(capability, projectConfig);

    const results = [];
    for (const request of requests) {
        let result;
        try {
            result = await provider.generate(capability, request, { timeout: 300000 });

            /*
             * A flows `gen.video` node is a generation like any other, and was
             * the third path recording nothing. The attempt is recorded here
             * rather than in out.asset, because a node run on its own stores no
             * asset at all — and an attempt with no asset id is still a record
             * that this model was asked for this shape of shot.
             */
            if (capability === 'video') {
                try {
                    const db = require('../../db/database').db;
                    require('../video-attempt').recordVideoAttempt(db, {
                        shotId: ctx && ctx.shotId, projectId: ctx && ctx.projectId,
                        provider: provider.id, model: result && result.provider_model,
                        durationSeconds: request && (request.duration_s || request.duration),
                        sceneCard: (ctx && ctx.sceneCard) || {},
                    });
                } catch (_) { /* never fail a node that already cost money */ }
            }
        } catch (err) {
            return { ok: false, error: err.message, providerId: provider.id };
        }
        if (!result || !result.ok) {
            return { ok: false, error: (result && result.error) || `${capability} generation failed`, providerId: provider.id };
        }
        results.push(result);
    }

    const port = OUTPUT_PORT[capability] || 'image';
    const values = results.map(r => r.data);

    return {
        ok: true,
        providerId: provider.id,
        // A provider fallback is not an error; it is recorded so the UI can say
        // so without painting the node red.
        routingNote: (projectConfig[capability] && provider.id !== projectConfig[capability])
            ? `requested '${projectConfig[capability]}', ran on '${provider.id}'`
            : '',
        outputs: { [port]: PORT(port, values.length === 1 ? values[0] : values) },
        count: results.length,
    };
}

// Every gen.* node type shares the one implementation.
const handlers = {};
for (const id of ['gen.llm', 'gen.image', 'gen.video', 'gen.voice', 'gen.music',
                  'gen.sfx', 'gen.ambient', 'gen.lipsync', 'gen.post', 'gen.model3d']) {
    handlers[id] = { execute: executeGenerator };
}

module.exports = { handlers, executeGenerator, contextFromInputs };
