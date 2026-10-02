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
    // A world leaves on the wire its collider mesh travels on; the splat and
    // the camera poses are read from the asset, not carried by an edge.
    world: 'model3d',
};

/** First value on a port, whether it arrived alone or in a collector array. */
function firstValue(portValue) {
    if (!portValue) return null;
    return Array.isArray(portValue) ? (portValue[0] && portValue[0].value) : portValue.value;
}

/**
 * Fold wired inputs into the context the payload builder reads.
 *
 * Wired text is shot direction by default, preserving the scene and camera.
 * Complete replacement requires the explicit prompt_mode: replace setting.
 */
function contextFromInputs(ctx, inputs, node) {
    const merged = { ...ctx, overrides: { ...(ctx.overrides || {}), ...((node.config || {}).overrides || {}) } };
    const config = node.config || {};

    const text = firstValue(inputs.text);
    if (text) {
        merged.sceneCard = { ...(merged.sceneCard || {}), direction: [merged.sceneCard && merged.sceneCard.direction, text].filter(Boolean).join('. ') };
        merged.flowDirection = text;
        if (config.prompt_mode === 'replace') merged.promptOverride = text;
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

async function executeGenerator(node, inputs, ctx) {
    const def = nodeType(node.type);
    const capability = def && def.capability;
    if (!capability) return { ok: false, error: `node type '${node.type}' declares no capability` };

    if (ctx.approvedGenerationRevision && ctx.shot && ctx.shot.id) {
        const current = require('../generation-revision').generationRevision(require('../../db/database').db, ctx.shot.id, ctx.approvedInputAssets || []);
        if (!current || current.fingerprint !== ctx.approvedGenerationRevision.fingerprint) {
            return { ok: false, code: 'GENERATION_REVISION_MOVED', error: 'Generation inputs changed after approval. Review a fresh apply plan.' };
        }
    }
    const config = node.config || {};
    const projectConfig = { ...providerConfigOf(ctx.project) };
    if (config.provider) projectConfig[capability] = config.provider;
    const provider = ctx.providerFor
        ? ctx.providerFor(capability, projectConfig)
        : require('../providers').resolveGenerator(capability, projectConfig);
    const merged = contextFromInputs(ctx, inputs || {}, node);
    merged.project = { ...ctx.project, provider_config: JSON.stringify(projectConfig) };
    if (capability === 'video' && merged.flowDirection) {
        merged.sceneCard = { ...merged.sceneCard, action: config.prompt_mode === 'replace' ? merged.flowDirection
            : [ctx.sceneCard && (ctx.sceneCard.action || ctx.sceneCard.description), merged.flowDirection].filter(Boolean).join('. ') };
    }
    // Resolve reference slots/tags and prompt limits against the node's actual adapter.
    if (capability === 'image') {
        merged.imagePromptLimit = provider.promptLimit;
        if (ctx.shot && ctx.shot.id) {
            const refreshed = require('../capability-payloads').loadShotContext(ctx.shot.id, {
                providerConfig: projectConfig, keepPlates: ctx.keepPlates,
                referenceSupport: { canAttach: !!provider.supportsReferenceImages,
                    canTag: !!provider.supportsReferenceTags, maxReferenceImages: provider.maxReferenceImages },
            });
            for (const key of ['references', 'tagged', 'anchorTag', 'anchorAttached', 'anchorCovers', 'referenceDiagnostics']) {
                merged[key] = refreshed[key];
            }
        }
    }
    if (merged.previsApplication && !merged.previsApplication.applied && ['image', 'video'].includes(capability)) {
        return { ok: false, error: 'Apply or re-seed the staged Previs before running this generation.', code: 'STAGED_PREVIS' };
    }

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

    const payload = built.payload;
    const requests = Array.isArray(payload) ? payload : [payload];
    if (requests.length === 0) {
        return { ok: true, skipped: true, message: `no ${capability} work for this node`, outputs: {} };
    }

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
        generation: { ...built.meta, payload_fingerprint: require('crypto').createHash('sha256').update(JSON.stringify(payload)).digest('hex') },
        // A provider fallback is not an error; it is recorded so the UI can say
        // so without painting the node red.
        routingNote: (projectConfig[capability] && provider.id !== projectConfig[capability])
            ? `requested '${projectConfig[capability]}', ran on '${provider.id}'`
            : '',
        outputs: { [port]: PORT(port, values.length === 1 ? values[0] : values) },
        count: results.length,
    };
}

/*
 * Every gen.* node type shares the one implementation, and the SET is derived
 * from the registry rather than typed here. It was a hand-written list, which
 * is the second-list shape this codebase keeps paying for: a node type added to
 * NODE_TYPES and forgotten here is listed on the canvas, exposed as an MCP
 * tool, and dispatches to nothing — which reads as the node being broken rather
 * than unregistered.
 */
const { NODE_TYPES } = require('../flow-node-types');
const handlers = {};
for (const [id, def] of Object.entries(NODE_TYPES)) {
    if (def.kind === 'generator') handlers[id] = { execute: executeGenerator };
}

module.exports = { handlers, executeGenerator, contextFromInputs };
