/**
 * Built-in flow templates — the ready-made shelf.
 *
 * "Choose from ready-made flows: multi-model video, image, character sheets,
 * and more — drop in your media and run."
 *
 * Templates are DATA, not seeded rows: they stay versioned with the code, and
 * validateGraph() can police them in CI rather than at first use by whoever
 * happened to pick the broken one.
 *
 * They are written against the finished executor — collector ports, fan-out
 * branching, the budget gate — rather than alongside it, so the semantics they
 * rely on are the ones that shipped.
 */

const { validateGraph } = require('./flow-graph');

const COL = 250;   // horizontal spacing, so an instantiated flow opens readable
const ROW = 120;

/**
 * Each template is a function of context so ids stay stable and nothing is
 * captured by reference between instantiations.
 */
const TEMPLATES = {
    'prompt-to-image': {
        name: 'Prompt → image',
        description: 'The simplest useful flow: a prompt, a keyframe, saved to the project.',
        build: () => ({
            nodes: [
                { id: 'prompt', type: 'in.prompt', label: 'Prompt', config: { text: '' }, x: 60, y: 80 },
                { id: 'image', type: 'gen.image', label: 'Image', config: {}, x: 60 + COL, y: 80 },
                { id: 'save', type: 'out.asset', label: 'Save', config: { asset_type: 'keyframe' }, x: 60 + COL * 2, y: 80 },
            ],
            edges: [
                { from: 'prompt', fromPort: 'text', to: 'image', toPort: 'text' },
                { from: 'image', fromPort: 'image', to: 'save', toPort: 'image' },
            ],
        }),
    },

    'multi-model-video': {
        name: 'Multi-model video',
        description: 'One prompt, one keyframe, the same shot rendered by three video providers, then pick the best.',
        build: () => ({
            nodes: [
                { id: 'prompt', type: 'in.prompt', label: 'Prompt', config: { text: '' }, x: 60, y: 120 },
                { id: 'image', type: 'gen.image', label: 'Keyframe', config: {}, x: 60 + COL, y: 120 },
                // The variant axis IS the provider — that is what "multi-model" means.
                { id: 'fan', type: 'tf.fanout', label: 'Three models', config: { count: 3, providers: ['gridlight', 'runway', 'openai'] }, x: 60 + COL * 2, y: 120 },
                { id: 'video', type: 'gen.video', label: 'Video', config: {}, x: 60 + COL * 3, y: 120 },
                { id: 'pick', type: 'tf.select', label: 'Pick a take', config: {}, x: 60 + COL * 4, y: 120 },
                { id: 'save', type: 'out.asset', label: 'Save', config: { asset_type: 'video_raw' }, x: 60 + COL * 5, y: 120 },
            ],
            edges: [
                { from: 'prompt', fromPort: 'text', to: 'image', toPort: 'text' },
                { from: 'image', fromPort: 'image', to: 'fan', toPort: 'any' },
                { from: 'fan', fromPort: 'any', to: 'video', toPort: 'image' },
                { from: 'video', fromPort: 'video', to: 'pick', toPort: 'any' },
                { from: 'pick', fromPort: 'any', to: 'save', toPort: 'video' },
            ],
        }),
    },

    'character-sheet': {
        name: 'Character sheet',
        description: 'Four consistent views of one character, driven by its locked consistency profile.',
        build: () => ({
            nodes: [
                // The subject node is the differentiator: identity travels as a
                // typed value rather than being re-pasted into four prompts.
                { id: 'subject', type: 'in.subject', label: 'Character', config: { subject_type: 'character', subject_name: '' }, x: 60, y: 120 },
                { id: 'views', type: 'tf.fanout', label: 'Four views', config: { count: 4, prompts: ['front view', 'side profile', 'three-quarter view', 'back view'] }, x: 60 + COL, y: 120 },
                { id: 'sheet', type: 'gen.image', label: 'View', config: {}, x: 60 + COL * 2, y: 120 },
                { id: 'save', type: 'out.asset', label: 'Save', config: { asset_type: 'character_sheet' }, x: 60 + COL * 3, y: 120 },
            ],
            edges: [
                { from: 'subject', fromPort: 'subject', to: 'views', toPort: 'any' },
                { from: 'views', fromPort: 'any', to: 'sheet', toPort: 'subject' },
                { from: 'sheet', fromPort: 'image', to: 'save', toPort: 'image' },
            ],
        }),
    },

    'shot-to-clip': {
        name: 'Shot → clip',
        description: 'Take a shot from the screenplay through keyframe and video to a saved clip.',
        build: () => ({
            nodes: [
                { id: 'shot', type: 'in.scene', label: 'Shot', config: {}, x: 60, y: 100 },
                { id: 'image', type: 'gen.image', label: 'Keyframe', config: {}, x: 60 + COL, y: 100 },
                { id: 'video', type: 'gen.video', label: 'Clip', config: {}, x: 60 + COL * 2, y: 100 },
                { id: 'save', type: 'out.asset', label: 'Save', config: { asset_type: 'video_raw' }, x: 60 + COL * 3, y: 100 },
            ],
            edges: [
                { from: 'shot', fromPort: 'text', to: 'image', toPort: 'text' },
                { from: 'image', fromPort: 'image', to: 'video', toPort: 'image' },
                { from: 'video', fromPort: 'video', to: 'save', toPort: 'video' },
            ],
        }),
    },

    'dialogue-to-lipsync': {
        name: 'Dialogue → lip-sync',
        description: 'Voice the shot\'s dialogue and sync it to the rendered clip.',
        build: () => ({
            nodes: [
                { id: 'shot', type: 'in.scene', label: 'Shot', config: {}, x: 60, y: 60 },
                { id: 'clip', type: 'in.asset', label: 'Rendered clip', config: {}, x: 60, y: 60 + ROW * 2 },
                { id: 'voice', type: 'gen.voice', label: 'Dialogue', config: {}, x: 60 + COL, y: 60 },
                { id: 'sync', type: 'gen.lipsync', label: 'Lip-sync', config: {}, x: 60 + COL * 2, y: 60 + ROW },
                { id: 'save', type: 'out.asset', label: 'Save', config: { asset_type: 'video_synced' }, x: 60 + COL * 3, y: 60 + ROW },
            ],
            edges: [
                { from: 'shot', fromPort: 'text', to: 'voice', toPort: 'text' },
                { from: 'voice', fromPort: 'audio', to: 'sync', toPort: 'audio' },
                { from: 'clip', fromPort: 'video', to: 'sync', toPort: 'video' },
                { from: 'sync', fromPort: 'video', to: 'save', toPort: 'video' },
            ],
        }),
    },

    'scene-soundscape': {
        name: 'Scene soundscape',
        description: 'Score, effects and an ambient bed for a scene, mixed into one track.',
        build: () => ({
            nodes: [
                { id: 'scene', type: 'in.scene', label: 'Scene', config: {}, x: 60, y: 60 + ROW },
                { id: 'music', type: 'gen.music', label: 'Score', config: {}, x: 60 + COL, y: 60 },
                { id: 'sfx', type: 'gen.sfx', label: 'Effects', config: {}, x: 60 + COL, y: 60 + ROW },
                { id: 'amb', type: 'gen.ambient', label: 'Ambience', config: {}, x: 60 + COL, y: 60 + ROW * 2 },
                // The collector port earns its keep here: three audio sources,
                // one input.
                { id: 'mix', type: 'tf.mix', label: 'Mix', config: {}, x: 60 + COL * 2, y: 60 + ROW },
                { id: 'save', type: 'out.asset', label: 'Save', config: { asset_type: 'music' }, x: 60 + COL * 3, y: 60 + ROW },
            ],
            edges: [
                { from: 'scene', fromPort: 'text', to: 'music', toPort: 'text' },
                { from: 'scene', fromPort: 'text', to: 'sfx', toPort: 'text' },
                { from: 'scene', fromPort: 'text', to: 'amb', toPort: 'text' },
                { from: 'music', fromPort: 'audio', to: 'mix', toPort: 'audio' },
                { from: 'sfx', fromPort: 'audio', to: 'mix', toPort: 'audio' },
                { from: 'amb', fromPort: 'audio', to: 'mix', toPort: 'audio' },
                { from: 'mix', fromPort: 'audio', to: 'save', toPort: 'audio' },
            ],
        }),
    },
};

/**
 * Build a template's graph.
 *
 * ctx may carry projectId / sceneId / shotId to pre-fill node config; the
 * topology never depends on it, so a template is the same shape everywhere.
 *
 * @throws when the id is unknown — a silent empty graph would look like a
 *         template that simply does nothing.
 */
function instantiate(templateId, ctx) {
    const template = TEMPLATES[templateId];
    if (!template) {
        throw new Error(`unknown flow template '${templateId}'`);
    }

    const graph = template.build(ctx || {});
    const context = ctx || {};

    for (const node of graph.nodes) {
        if (node.type === 'in.scene') {
            node.config = { ...node.config, scene_id: context.sceneId || '', shot_id: context.shotId || '' };
        }
    }
    return graph;
}

/** The shelf, for a picker — without building every graph twice. */
function listTemplates() {
    return Object.entries(TEMPLATES).map(([id, t]) => {
        const graph = t.build({});
        return {
            id,
            name: t.name,
            description: t.description,
            node_count: graph.nodes.length,
            edge_count: graph.edges.length,
        };
    });
}

// A template that does not validate is a trap for whoever picks it, so fail at
// load rather than at first use.
for (const id of Object.keys(TEMPLATES)) {
    const result = validateGraph(TEMPLATES[id].build({}));
    if (!result.ok) {
        throw new Error(`flow template '${id}' is invalid: ${JSON.stringify(result.errors)}`);
    }
}

module.exports = { TEMPLATES, instantiate, listTemplates };
