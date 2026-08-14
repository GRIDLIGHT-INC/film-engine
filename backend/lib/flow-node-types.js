/**
 * Flow node-type registry — what a node IS.
 *
 * The canvas, the validator and (from Phase 2) the executor all need the same
 * answer to "what ports does gen.lipsync have?", so it lives in one place.
 *
 * This is the RUNTIME source of truth. Its documented twin,
 * docs/plans/flows-canvas-node-taxonomy.json, is the design artefact, and
 * tests/flow-graph.test.js asserts the two agree on every node and every port
 * in both directions — a registry that quietly disagrees with the palette
 * users see would produce edges the UI draws and the server refuses.
 *
 * Ports are typed because a media graph is not a dependency list: lipsync takes
 * one video and one audio, and wiring text into it is an error worth refusing
 * at the point the user draws it, not at the point a provider rejects it.
 */

// Port types an edge can carry. `any` is the wildcard used by control nodes
// (fan-out, select) which pass values through without inspecting them.
const PORT_TYPES = ['text', 'image', 'video', 'audio', 'model3d', 'subject', 'timeline', 'any'];

const NODE_TYPES = {
    'in.prompt': {
        label: "Prompt",
        kind: 'input',
        inputs: [],
        outputs: ['text'],
        capability: null,
        pipelineSteps: [],
    },
    'in.asset': {
        label: "Asset",
        kind: 'input',
        inputs: [],
        outputs: ['image', 'video', 'audio', 'model3d'],
        capability: null,
        pipelineSteps: [],
    },
    'in.subject': {
        label: "Subject Reference",
        kind: 'input',
        inputs: [],
        outputs: ['subject', 'image'],
        capability: null,
        pipelineSteps: [],
    },
    'in.scene': {
        label: "Scene / Shot",
        kind: 'input',
        inputs: [],
        outputs: ['text', 'subject'],
        capability: null,
        pipelineSteps: [],
    },
    'gen.llm': {
        label: "Text / LLM",
        kind: 'generator',
        inputs: ['text'],
        outputs: ['text'],
        capability: 'llm',
        pipelineSteps: [],
    },
    'gen.image': {
        label: "Image",
        kind: 'generator',
        inputs: ['text', 'image', 'subject'],
        outputs: ['image'],
        capability: 'image',
        pipelineSteps: ['keyframe'],
    },
    'gen.video': {
        label: "Video",
        kind: 'generator',
        inputs: ['text', 'image', 'subject'],
        outputs: ['video'],
        capability: 'video',
        pipelineSteps: ['video'],
    },
    'gen.voice': {
        label: "Voice",
        kind: 'generator',
        inputs: ['text', 'subject'],
        outputs: ['audio'],
        capability: 'voice',
        pipelineSteps: ['voice'],
    },
    'gen.music': {
        label: "Music",
        kind: 'generator',
        inputs: ['text'],
        outputs: ['audio'],
        capability: 'music',
        pipelineSteps: ['music'],
    },
    'gen.sfx': {
        label: "Sound Effect",
        kind: 'generator',
        inputs: ['text'],
        outputs: ['audio'],
        capability: 'sfx',
        pipelineSteps: ['sfx'],
    },
    'gen.ambient': {
        label: "Ambient Bed",
        kind: 'generator',
        inputs: ['text'],
        outputs: ['audio'],
        capability: 'ambient',
        pipelineSteps: ['ambient'],
    },
    'gen.lipsync': {
        label: "Lip-Sync",
        kind: 'generator',
        inputs: ['video', 'audio'],
        outputs: ['video'],
        capability: 'lipsync',
        pipelineSteps: ['lipsync'],
    },
    'gen.post': {
        label: "Post (Upscale / Restore / Grade)",
        kind: 'generator',
        inputs: ['video', 'image'],
        outputs: ['video', 'image'],
        capability: 'post',
        pipelineSteps: ['post'],
    },
    'gen.model3d': {
        label: "3D Model",
        kind: 'generator',
        inputs: ['text', 'image', 'subject'],
        outputs: ['model3d'],
        capability: 'model3d',
        pipelineSteps: [],
    },
    'in.stock': {
        label: "Licensed Catalog",
        kind: 'input',
        inputs: ['text'],
        outputs: ['audio', 'video', 'image'],
        capability: 'stock',
        pipelineSteps: [],
    },
    'tf.mix': {
        multiInputs: ['audio'],
        label: "Audio Mix",
        kind: 'transform',
        inputs: ['audio', 'video'],
        outputs: ['audio'],
        capability: null,
        pipelineSteps: [],
    },
    'tf.stitch': {
        label: "Stitch Clips",
        kind: 'transform',
        inputs: ['video'],
        outputs: ['video'],
        capability: null,
        pipelineSteps: [],
    },
    'tf.encode': {
        label: "Encode",
        kind: 'transform',
        inputs: ['video'],
        outputs: ['video'],
        capability: null,
        pipelineSteps: [],
    },
    'tf.fanout': {
        label: "Variants",
        kind: 'transform',
        inputs: ['any'],
        outputs: ['any'],
        capability: null,
        pipelineSteps: [],
    },
    'tf.select': {
        label: "Select / Compare",
        kind: 'transform',
        inputs: ['any'],
        outputs: ['any'],
        capability: null,
        pipelineSteps: [],
    },
    'out.assembly': {
        multiInputs: ['video', 'audio'],
        label: "Assembly",
        kind: 'output',
        inputs: ['video', 'audio'],
        outputs: ['timeline'],
        capability: null,
        pipelineSteps: ['assembly'],
    },
    'out.asset': {
        label: "Save Asset",
        kind: 'output',
        inputs: ['image', 'video', 'audio', 'model3d'],
        outputs: [],
        capability: null,
        pipelineSteps: [],
    },
    'out.timeline': {
        label: "Export",
        kind: 'output',
        inputs: ['timeline', 'video'],
        outputs: [],
        capability: null,
        pipelineSteps: [],
    },
};

/** Node-type definition, or null when the type is unknown. */
function nodeType(id) {
    return Object.prototype.hasOwnProperty.call(NODE_TYPES, id) ? NODE_TYPES[id] : null;
}

/**
 * May a value leaving `fromType` enter `toType`?
 *
 * Exact match, or either side being `any`. Deliberately not a subtype lattice:
 * image-into-video looks tempting (a keyframe does seed a video) but the
 * distinction is exactly what stops a user wiring an audio track into an
 * init_image slot, and a generator that accepts several kinds declares several
 * ports instead.
 */
function portsCompatible(fromType, toType) {
    if (!fromType || !toType) return false;
    if (!PORT_TYPES.includes(fromType) || !PORT_TYPES.includes(toType)) return false;
    return fromType === toType || fromType === 'any' || toType === 'any';
}

/** Node types grouped for the canvas palette. */
function byKind(kind) {
    return Object.entries(NODE_TYPES).filter(([, def]) => def.kind === kind).map(([id]) => id);
}

/** The node type implementing a given pipeline step, or null. */
function nodeTypeForStep(stepId) {
    for (const [id, def] of Object.entries(NODE_TYPES)) {
        if (def.pipelineSteps.includes(stepId)) return id;
    }
    return null;
}

module.exports = { NODE_TYPES, PORT_TYPES, nodeType, portsCompatible, byKind, nodeTypeForStep };
