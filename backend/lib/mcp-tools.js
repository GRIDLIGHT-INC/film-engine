/**
 * The MCP tool surface, GENERATED rather than written.
 *
 * Two sets, and neither is a hand-kept list:
 *
 *   1. One tool per entry in the node-type registry (lib/flow-node-types.js) —
 *      the same registry the canvas palette reads. Adding a node type therefore
 *      adds an MCP tool, with the right ports, without anyone remembering to.
 *      That is the whole reason this file generates instead of enumerating:
 *      a hand-written tool list is a second palette, and two palettes drift.
 *
 *   2. One tool per shipped route on routes/flows.js, dispatched THROUGH
 *      handleFlows rather than around it. Reimplementing "run a flow" here
 *      would mean a second budget gate, a second validation pass and a second
 *      set of bugs; instead the tools speak HTTP to the same router the SPA
 *      does, via an in-process request shim. Phase 6 shipped a route that was
 *      declared and never dispatched, so tests/mcp-tools.test.js proves every
 *      tool's route is really reachable rather than trusting this table.
 *
 * Transport lives in ../mcp-server.js. This module is pure enough to test
 * without a process boundary.
 */

const { NODE_TYPES, PORT_TYPES, nodeType } = require('./flow-node-types');
const { handlerFor } = require('./node-handlers');
const { handleFlows, runContext } = require('../routes/flows');

// Pre-production routes. These are what let an agent do the work that has to
// happen BEFORE any image is generated: read the screenplay, describe the
// characters and locations, write the shot list, choose the look. Exposing the
// flows engine alone left an agent able to run generation and unable to give it
// anything to be consistent about.
const { handleProjects } = require('../routes/projects');
const { handleProviders } = require('../routes/providers');
const { handleStoryStructure } = require('../routes/story-structure');
const { handleScripts } = require('../routes/scripts');
const { handleScenes } = require('../routes/scenes');
const { handleShots } = require('../routes/shots');
const { handleCharacters } = require('../routes/characters');
const { handleLocations } = require('../routes/locations');
const { handleStoryboard } = require('../routes/storyboard');
const { handleComments } = require('../routes/scripts');
const { handleMoodBoard } = require('../routes/mood-board');
const { handleMediaImport } = require('../routes/media-import');
const { handleVideoGen } = require('../routes/video-gen');
const { handleSequences } = require('../routes/sequences');
const { handleAnnotations } = require('../routes/annotations');
const { handleBreakdown } = require('../routes/breakdown');
const { handlePrevis } = require('../routes/previs');
const { handleThreeD } = require('../routes/threed');
const { handleProductionReports } = require('../routes/production-reports');
const { handleBudget } = require('../routes/budget');
const { handleConsistency } = require('../routes/consistency');
const { handleStoryBible } = require('../routes/story-bible');

const NODE_TOOL_PREFIX = 'node_';

/**
 * The one route with no tool. A tools/call returns a single result, so an SSE
 * endpoint has nothing to offer over the blocking one — flow_run covers the
 * same work. Named as a constant because a silent omission and a considered
 * one look identical in a tool list.
 */
const SSE_EXCEPTION = 'runFlowStreamRoute';

/** `gen.image` -> `node_gen_image`. */
function toolNameForNodeType(id) {
    return NODE_TOOL_PREFIX + id.replace(/[.\-]/g, '_');
}

const _nodeTypeByToolName = new Map(
    Object.keys(NODE_TYPES).map(id => [toolNameForNodeType(id), id])
);

// ── In-process HTTP shim ────────────────────────────────────────────────────

/**
 * Call the flows router without a socket.
 *
 * Same shape as the shims in tests/flows-routes.test.js: handleFlows only ever
 * touches method/body on the request and writeHead/end on the response.
 */
function callRoute(method, urlPath, body, handler) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const req = { method, body: body || {}, url: urlPath, headers: {} };

        let settled = false;
        const finish = (status, payload) => {
            if (settled) return;
            settled = true;
            let parsed = payload;
            try { parsed = JSON.parse(payload); } catch (_) { /* leave as-is */ }
            resolve({ _status: status, body: parsed });
        };

        const res = {
            statusCode: 200,
            writableEnded: false,
            setHeader() {},
            writeHead(code) { this.statusCode = code; return this; },
            write() {},
            end(payload) { this.writableEnded = true; finish(this.statusCode, payload); },
        };

        try {
            // Production tools name their own handler; flow tools keep the
            // default. Every route handler in this codebase has the same
            // (req, res, parts, query) shape, which is what makes one shim
            // enough -- see ADR-002.
            const route = handler || handleFlows;
            const returned = route(req, res, parts, {});
            // Several handlers are async; an unhandled rejection would hang the
            // tool call rather than fail it.
            if (returned && typeof returned.catch === 'function') {
                returned.catch(err => finish(500, JSON.stringify({ error: err.message })));
            }
        } catch (err) {
            finish(500, JSON.stringify({ error: err.message }));
        }
    });
}

// ── Set 1: a tool per node type ─────────────────────────────────────────────

const PORT_VALUE_SCHEMA = {
    type: 'object',
    description: 'A typed port value, exactly as an edge carries it.',
    properties: {
        type: { type: 'string', enum: PORT_TYPES },
        value: { description: 'Text, or { assetId, path, url } for media.' },
    },
    required: ['type', 'value'],
};

function inputPortSchema(port, def) {
    const multi = (def.multiInputs || []).includes(port);
    if (!multi) return PORT_VALUE_SCHEMA;
    return {
        description: `Collector port: accepts several ${port} values, all of which are kept.`,
        anyOf: [PORT_VALUE_SCHEMA, { type: 'array', items: PORT_VALUE_SCHEMA }],
    };
}

function describeNodeTool(id, def) {
    const bits = [`Run the \`${id}\` node — ${def.label}.`, `Kind: ${def.kind}.`];
    if (def.capability) {
        bits.push(`Calls the '${def.capability}' capability, so it resolves a provider and may cost money.`);
    }
    bits.push(def.inputs.length ? `Input ports: ${def.inputs.join(', ')}.` : 'No input ports — this is a source.');
    bits.push(`Output ports: ${def.outputs.join(', ')}.`);
    if (def.pipelineSteps && def.pipelineSteps.length) {
        bits.push(`Implements pipeline step(s): ${def.pipelineSteps.join(', ')}.`);
    }
    bits.push('Bind context with shot_id (preferred) or project_id; a node needing shot data without one skips rather than fails.');
    return bits.join(' ');
}

function nodeToolFor(id, def) {
    const properties = {
        shot_id: { type: 'string', description: 'Shot to run against. Loads scene card, characters, consistency profile and existing assets.' },
        project_id: { type: 'string', description: 'Used when no shot is named. Narrower context: project settings and provider config only.' },
        config: {
            type: 'object',
            description: 'Node configuration — the same object the canvas inspector edits (e.g. text, model, seed, provider, asset_id).',
        },
        vars: { type: 'object', description: 'Values substituted into {{placeholders}} in prompt text.' },
    };

    if (def.inputs.length) {
        properties.inputs = {
            type: 'object',
            description: 'Upstream port values, as if edges had delivered them.',
            properties: Object.fromEntries(def.inputs.map(p => [p, inputPortSchema(p, def)])),
        };
    }

    return {
        name: toolNameForNodeType(id),
        description: describeNodeTool(id, def),
        inputSchema: { type: 'object', properties },
        _kind: 'node',
        _nodeType: id,
    };
}

/** Match the array/scalar shape the executor's resolveNodeInputs would produce. */
function normalizeInputs(raw, def) {
    const inputs = {};
    if (!raw || typeof raw !== 'object') return inputs;

    const collectors = new Set(def.multiInputs || []);
    for (const port of def.inputs) {
        const value = raw[port];
        if (value === undefined || value === null) continue;
        if (collectors.has(port)) inputs[port] = Array.isArray(value) ? value : [value];
        else inputs[port] = Array.isArray(value) ? value[0] : value;
    }
    return inputs;
}

async function callNodeTool(nodeTypeId, args) {
    const def = nodeType(nodeTypeId);
    const handler = handlerFor(nodeTypeId);
    if (!def) return { ok: false, error: `unknown node type '${nodeTypeId}'` };
    if (!handler) return { ok: false, error: `no handler registered for '${nodeTypeId}'` };

    // Same context loader the run routes use, so a node called over MCP sees
    // exactly what the same node sees inside a flow.
    const resolved = runContext({
        shot_id: args.shot_id, project_id: args.project_id, vars: args.vars || {},
    });
    if (resolved.error) return { ok: false, error: resolved.error };

    const node = {
        id: args.node_id || `mcp:${nodeTypeId}`,
        type: nodeTypeId,
        config: args.config || {},
    };

    try {
        const result = await handler.execute(node, normalizeInputs(args.inputs, def), resolved.ctx);
        return result || { ok: false, error: 'handler returned nothing' };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── Set 2: a tool per shipped flows route ───────────────────────────────────
//
// `handler` names the function in routes/flows.js this tool reaches, and the
// test asserts the mapping is total in both directions.

/**
 * Set 3: the pre-production surface.
 *
 * The continuity failure these exist to prevent: a screenplay upload creates
 * character and location rows that are NAME SKELETONS -- `appearance_prompt` is
 * an empty string, a location's description is "EXT location (3 mentions)".
 * buildStoryboardPrompt looks both up, finds nothing to inject, and every
 * keyframe invents its own Maya on its own street. The fix is not a better
 * prompt; it is filling those records before generating, and that is exactly
 * the work an agent is good at and the flows tools could not reach.
 *
 * Same dispatch as ROUTE_TOOLS -- through the real handler, so validation,
 * scene-card checking and asset registration behave identically to HTTP.
 */
/**
 * Deliberately NOT here: breakdown_run and entities_describe.
 *
 * Both routes exist and both work — over HTTP, where the server resolves an LLM
 * provider and pays for the call. Over MCP they are a category error. The whole
 * point of this surface is that the AGENT HOST is the model: Claude connects,
 * Claude reasons, and Film Engine keeps the data and the media. A tool that
 * hands the reasoning back to a server-side LLM asks the user to hold a second
 * API key for a question the model on the other end of the socket has already
 * read, and it fails with a billing error the model cannot act on.
 *
 * The replacements are the plain data tools, and they are strictly better,
 * because the model composing a card or a description has the whole revision in
 * context rather than one scene of it:
 *
 *   breakdown_run      -> read the scene with script_get, write the cards,
 *                         create them with shot_create.
 *   entities_describe  -> read the screenplay, write the descriptions, save
 *                         them with character_update / location_update /
 *                         prop_update.
 *
 * tests/mcp-no-server-llm.test.js enforces this by deriving the LLM-calling
 * route modules from the source rather than from a list, so a tool added later
 * against one of them fails immediately.
 */
const PRODUCTION_TOOLS = [
    {
        name: 'storyboard_upload',
        handler: handleStoryboard, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/storyboard/import`,
        body: a => ({ data: a.image, ...(a.force ? { ignore_lock: true } : {}) }),
        description:
            'Put a storyboard frame you generated YOURSELF onto a shot. FREE \u2014 nothing is '
            + 'generated here and no image provider is called, so this is how to board a film without '
            + 'spending image credits: read the shot card and its references, make the frame, show it '
            + 'for approval, then upload it. image is a PNG data URI. It becomes the shot\u2019s '
            + 'current frame and the one it replaces is KEPT as a recoverable version. Refused with '
            + 'BOARD_LOCKED on a finished board; pass force to override, which is a deliberate act.',
        schema: {
            shot_id: { type: 'string' },
            image: { type: 'string', description: 'data:image/png;base64,...' },
            force: { type: 'boolean', description: 'Replace a frame on a LOCKED board.' },
        },
        required: ['shot_id', 'image'],
    },
    {
        name: 'previs_image_upload',
        handler: handlePrevis, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/previs/image/import`,
        body: a => ({ data: a.image }),
        description:
            'Stand a picture in the previs stage for a shot \u2014 a reference to block against, or a '
            + 'frame you generated. FREE. image is a PNG data URI. It does not become the shot\u2019s '
            + 'storyboard frame; use storyboard_upload for that.',
        schema: {
            shot_id: { type: 'string' },
            image: { type: 'string', description: 'data:image/png;base64,...' },
        },
        required: ['shot_id', 'image'],
    },
    {
        name: 'model_upload',
        handler: handleThreeD, method: 'POST',
        path: a => `/film/projects/${a.project_id}/models/import`,
        body: a => ({ data: a.model, name: a.name }),
        description:
            'Add a 3D model built elsewhere \u2014 Blender, Meshy, a library \u2014 to a project, for '
            + 'staging in previs. FREE. model is a GLB data URI (glTF 2.0 binary). Draco or meshopt '
            + 'compression is refused by name: re-export with compression off. Roughly 112MB maximum.',
        schema: {
            project_id: { type: 'string' },
            model: { type: 'string', description: 'data:model/gltf-binary;base64,...' },
            name: { type: 'string' },
        },
        required: ['project_id', 'model'],
    },
    {
        name: 'plate_refine',
        handler: handleLocations, method: 'POST',
        path: a => `/film/${a.kind === 'prop' ? 'props' : 'locations'}/${a.subject_id}/plate/refine`,
        body: a => ({ instruction: a.instruction, ...(a.view ? { view: a.view } : {}) }),
        description:
            'Keep an existing plate and change ONE thing: "make the road wet", "add low fog", "take '
            + 'the parked car out". SPENDS CREDITS. The plate travels as the reference so the place, '
            + 'the camera and the framing are kept \u2014 this is an EDIT, which is what an '
            + 'image-to-image provider does well, unlike a new VIEW which needs a camera move and has '
            + 'to be painted from words. It REPLACES the plate for that view: the previous picture is '
            + 'gone. Use view to refine one side of a location; omit it for the default plate.',
        schema: {
            subject_id: { type: 'string' },
            kind: { type: 'string', description: 'location | prop' },
            instruction: { type: 'string', description: 'The one thing that should change.' },
            view: { type: 'string', description: 'Which side, for a location with several. Omit for the default plate.' },
        },
        required: ['subject_id', 'kind', 'instruction'],
    },
    {
        name: 'video_preview',
        handler: handleVideoGen, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/video/preview`,
        description:
            'What generating this shot\u2019s clip would SEND, and what is missing, without sending it. '
            + 'FREE. Reports the provider, the model, the length and size, the full prompt, whether the '
            + 'STORYBOARD FRAME is attached, and whether a camera path from previs is going. The '
            + 'keyframe line is the one that matters: a prompt reads perfectly while the frame that '
            + 'would have made the clip match the board is absent, so the words look right and the '
            + 'footage comes back a different place. Read this before video_generate.',
        schema: { shot_id: { type: 'string' } },
        required: ['shot_id'],
    },
    {
        name: 'sequence_create',
        handler: handleSequences, method: 'POST',
        path: a => `/film/projects/${a.project_id}/sequences`,
        body: a => ({ shot_ids: a.shot_ids, name: a.name, description: a.description }),
        description:
            'Build a SEQUENCE: several shots, in play order, generated as one continuous move with a '
            + 'description true of all of them. Free \u2014 nothing generates. A single shot generates '
            + 'from ONE picture, so where it is going can only be described in words; a sequence travels '
            + 'between frames already approved, using the provider\u2019s first/last keyframe support. '
            + 'shot_ids order IS play order.',
        schema: {
            project_id: { type: 'string' },
            shot_ids: { type: 'array', description: 'Shot ids in the order they play. Order is the statement.' },
            name: { type: 'string' },
            description: { type: 'string', description: 'True of the whole sequence — light, weather, lens, what happens across the move. Reaches every clip.' },
        },
        required: ['project_id', 'shot_ids'],
    },
    {
        name: 'sequence_list',
        handler: handleSequences, method: 'GET',
        path: a => `/film/projects/${a.project_id}/sequences`,
        description: 'The sequences in a project, the shots each travels through, and whether every one of those shots has a keyframe. Free.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'sequence_plan',
        handler: handleSequences, method: 'GET',
        path: a => `/film/sequences/${a.sequence_id}/plan`,
        description:
            'What a sequence would SEND and how many generations it costs, without generating. FREE. '
            + 'Read this before sequence_generate: N shots become N-1 clips, and a shot with no keyframe '
            + 'refuses the whole sequence rather than being skipped \u2014 skipping would silently join '
            + 'the shots either side through a moment nobody has seen. Reports `degraded` when the '
            + 'project\u2019s video provider takes only one keyframe.',
        schema: { sequence_id: { type: 'string' } }, required: ['sequence_id'],
    },
    {
        name: 'sequence_generate',
        handler: handleSequences, method: 'POST',
        path: a => `/film/sequences/${a.sequence_id}/generate`,
        body: a => a.segment_index === undefined ? {} : { segment_index: a.segment_index },
        description:
            'Generate a sequence. SPENDS CREDITS \u2014 one generation per pair of neighbouring shots. '
            + 'Call sequence_plan first; it is free and states the exact number. Stops at the first '
            + 'provider refusal rather than buying the same failure repeatedly, and names what it did '
            + 'not attempt.',
        schema: {
            sequence_id: { type: 'string' },
            segment_index: { type: 'number', description: 'Optional zero-based leg. Omit only when deliberately buying the whole sequence.' },
        }, required: ['sequence_id'],
    },
    {
        name: 'sequence_generate_native',
        handler: handleSequences, method: 'POST',
        path: a => `/film/sequences/${a.sequence_id}/generate-native`,
        body: a => ({ ratio: a.ratio || '1280:720' }),
        description:
            'Runway native multi-shot recipe. SPENDS CREDITS and creates one clip containing 3–5 editorial cuts. '
            + 'Less deterministic than generating approved shots independently; call sequence_plan first for the exact body and cost.',
        schema: { sequence_id: { type: 'string' }, ratio: { type: 'string' } }, required: ['sequence_id'],
    },
    {
        name: 'sequence_stitch',
        handler: handleSequences, method: 'POST',
        path: a => `/film/sequences/${a.sequence_id}/stitch`,
        description:
            'Join a sequence\u2019s clips into ONE file. FREE \u2014 no provider is called and nothing is '
            + 'generated; it re-encodes footage already paid for. Refuses if any segment is missing '
            + 'rather than joining what is there, because a short film plays perfectly and is wrong. '
            + 'Refuses with NO_ENCODER, naming the remedy, when no ffmpeg can be found. Joining again '
            + 'replaces the previous file rather than adding another master.',
        schema: { sequence_id: { type: 'string' } }, required: ['sequence_id'],
    },
    {
        name: 'sequence_update',
        handler: handleSequences, method: 'PUT',
        path: a => `/film/sequences/${a.sequence_id}`,
        // Only what was actually supplied: the route merges, and sending
        // undefined keys would blank the fields this call did not mention.
        body: a => {
            const out = {};
            if (a.shot_ids !== undefined) out.shot_ids = a.shot_ids;
            if (a.name !== undefined) out.name = a.name;
            if (a.description !== undefined) out.description = a.description;
            return out;
        },
        description: 'Change a sequence\u2019s shots, order or description. Merged, not replaced, so renaming does not drop the description. Free.',
        schema: {
            sequence_id: { type: 'string' },
            shot_ids: { type: 'array' }, name: { type: 'string' }, description: { type: 'string' },
        },
        required: ['sequence_id'],
    },
    {
        name: 'sequence_delete',
        handler: handleSequences, method: 'DELETE',
        path: a => `/film/sequences/${a.sequence_id}`,
        description: 'Delete a sequence. Free. Clips it already generated are KEPT on their shots — deleting a plan must not delete the footage it produced.',
        schema: { sequence_id: { type: 'string' } }, required: ['sequence_id'],
    },
    {
        name: 'project_list',
        handler: handleProjects, method: 'GET',
        description: 'List every project. Start here to find the one you are working on and its id.',
        path: () => '/film/projects',
        schema: {}, required: [],
    },
    {
        name: 'project_get',
        handler: handleProjects, method: 'GET',
        description: 'Read one project: title, logline, genre, style_preset, aspect_ratio, fps, resolution and provider choices.',
        path: a => `/film/projects/${a.project_id}`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'project_create',
        handler: handleProjects, method: 'POST',
        description: 'Create a project. This is the first call for a new film — everything else needs a project_id. Set style_preset if you already know the look; it is applied to every generated frame and can be changed later with project_update. After this, post the screenplay with script_write.',
        path: () => '/film/projects',
        body: a => a || {},
        schema: {
            title: { type: 'string' },
            logline: { type: 'string' },
            genre: { type: 'string' },
            style_preset: { type: 'string', description: 'The look applied to every image prompt. Describe a look, not a subject — a style naming a creature puts one in every frame.' },
            aspect_ratio: { type: 'string', description: 'Delivery frame, e.g. "2.39:1", "16:9".' },
        },
        required: ['title'],
    },
    {
        name: 'project_delete',
        handler: handleProjects, method: 'DELETE',
        description: 'Delete a project and EVERYTHING in it: scenes, shots, scene cards, blocking, annotations, and every generated frame, clip and audio file. Generated media cost money and cannot be recovered. Never call this to tidy up, and never on a project you did not just create — confirm with the user first, by name.',
        path: a => `/film/projects/${a.project_id}`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'scene_delete',
        handler: handleScenes, method: 'DELETE',
        description: 'Delete one scene and, by cascade, every shot in it and everything generated from those shots. The safe way to revise a scene is scene_update, which keeps the shots; this is for a scene that should not exist.',
        path: a => `/film/scenes/${a.scene_id}`,
        schema: { scene_id: { type: 'string' } }, required: ['scene_id'],
    },
    /*
     * Quality is a directing decision, so an agent has to be able to make it.
     *
     * Named by TIER rather than by model, exactly as the page is: an agent that
     * asked for "gemini-3-pro-image" would be writing today's model name into
     * tomorrow's production, and the whole point of the table is that the name
     * changes without anything else doing so.
     */
    {
        name: 'quality_get',
        handler: handleProviders, method: 'GET',
        description: 'Read the image quality tier for a project, and what each tier would actually '
            + 'use on this install. A tier whose preferred provider holds no API key here falls '
            + 'through to the next one, and the reason says so.',
        path: a => `/film/projects/${a.project_id}/providers`,
        schema: { project_id: { type: 'string' } },
        required: ['project_id'],
    },
    {
        name: 'quality_set',
        handler: handleProviders, method: 'PUT',
        description: 'Set the image quality tier. "draft" for cheap exploration, "standard" for most '
            + 'storyboard frames, "precision" for difficult continuity — a frame that must hold an '
            + 'established location, a specific subject and a camera change together — or "auto" to '
            + 'lift to precision automatically when a request carries several references or edits an '
            + 'existing frame. This changes which model generates every subsequent frame and what it '
            + 'costs; it does NOT regenerate anything already on the board.',
        path: a => `/film/projects/${a.project_id}/providers`,
        body: a => ({ config: { image_quality: a.quality, ...(a.model ? { image_model: a.model } : {}) } }),
        schema: {
            project_id: { type: 'string' },
            quality: { type: 'string', enum: ['draft', 'standard', 'precision', 'auto'] },
            model: { type: 'string', description: 'Advanced: pin a specific model, overriding the tier. Normally omitted.' },
        },
        required: ['project_id', 'quality'],
    },
    {
        name: 'project_update',
        handler: handleProjects, method: 'PUT',
        description: 'Update a project. Use style_preset to set the look for every generated frame, and aspect_ratio to set the delivery frame (e.g. "2.39:1").',
        path: a => `/film/projects/${a.project_id}`,
        body: a => {
            const { project_id, ...rest } = a || {};
            return rest;
        },
        schema: {
            project_id: { type: 'string' },
            style_preset: { type: 'string', description: 'The visual look applied to every prompt.' },
            aspect_ratio: { type: 'string', description: 'Delivery frame, e.g. "2.39:1", "16:9".' },
            logline: { type: 'string' },
            genre: { type: 'string' },
            annotation_feedback: {
                type: 'boolean',
                description: 'Whether markup drawn on a frame reaches the next prompt for that shot. '
                    + 'Default false, in which case markup is notation for a human only. Turning it on '
                    + 'applies every NOTED mark on a shot to every subsequent generation of it, until '
                    + 'the mark is deleted — marks are about the shot, not about one attempt at it.',
            },
        },
        required: ['project_id'],
    },
    {
        name: 'bible_get',
        handler: handleStoryBible, method: 'GET',
        description: 'Read the story bible: what the people, places and things ARE, as opposed to what happens. Also reports which entities were written from which section. A bible reaches no image model by itself — read it, then write a character\u2019s appearance_prompt, a location\u2019s description or a prop\u2019s visual_prompt from it, or the project\u2019s style_preset, which is what generation actually uses.',
        path: a => `/film/projects/${a.project_id}/bible`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'bible_write',
        handler: handleStoryBible, method: 'PUT',
        description: 'Write story bible sections, keyed by heading — a character name, a place, "World", "Tone". MERGES: send only the sections you are changing and the rest survive. Sectioned rather than one document on purpose, so revising one character does not flag every entity in the film. Returns anything that has fallen behind as a result.',
        path: a => `/film/projects/${a.project_id}/bible`,
        body: a => ({ sections: a.sections }),
        schema: {
            project_id: { type: 'string' },
            sections: { type: 'object', description: 'An object of { "SECTION NAME": "body text" }.' },
        },
        required: ['project_id', 'sections'],
    },
    {
        name: 'bible_delete',
        handler: handleStoryBible, method: 'DELETE',
        description: 'Remove one bible section. Entities written from it keep saying so and are reported as behind, rather than being quietly unlinked — losing the record that a description came from something that no longer exists is worse than the gap itself.',
        path: a => `/film/projects/${a.project_id}/bible/${encodeURIComponent(a.section)}`,
        schema: {
            project_id: { type: 'string' },
            section: { type: 'string' },
        },
        required: ['project_id', 'section'],
    },
    {
        name: 'bible_drift',
        handler: handleStoryBible, method: 'GET',
        description: 'Which entity descriptions were written from a bible section that has since changed, and whether a plate was generated from each. Run it after bible_write. Warns only; nothing is blocked.',
        path: a => `/film/projects/${a.project_id}/bible-drift`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'script_get',
        handler: handleScripts, method: 'GET',
        description: 'Read the screenplay itself — the complete Fountain source of the latest version. Read this before writing any shot list, and before any rewrite: script_write takes the whole document, so you need the whole document.',
        // The LIST endpoint, which this used to point at, returns versions and
        // word counts and no screenplay. The description promised the source
        // and the route could not supply it, which is a worse failure than a
        // missing tool: the model believes it has read the script.
        path: a => `/film/projects/${a.project_id}/script/latest/fountain`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'script_versions',
        handler: handleScripts, method: 'GET',
        description: 'List the saved versions of the screenplay with their word and scene counts. Use it to confirm a rewrite was saved as a new version, and that the previous draft is still there.',
        path: a => `/film/projects/${a.project_id}/scripts`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'scene_list',
        handler: handleScenes, method: 'GET',
        description: 'List the scenes parsed from the screenplay, with INT/EXT, location and time of day.',
        path: a => `/film/projects/${a.project_id}/scenes`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'scene_get',
        handler: handleScenes, method: 'GET',
        description: 'Read one scene: its heading, its text, and who is in it.',
        path: a => `/film/scenes/${a.scene_id}`,
        schema: { scene_id: { type: 'string' } }, required: ['scene_id'],
    },
    {
        name: 'scene_update',
        handler: handleScenes, method: 'PUT',
        description: 'Rewrite ONE scene in the screenplay, leaving every other scene byte-identical. Send the complete replacement scene starting with its own heading (INT./EXT. LOCATION - TIME). This is the surgical edit: it splices into the Fountain and saves a new version, so scene ids and the shots hanging off them survive, and no other scene is marked as behind. Prefer this over script_write whenever you are changing one scene — a whole-document rewrite makes you reproduce every other scene faithfully, and one stray reflow marks work as needing redoing that does not. Shots are NOT re-derived: fix them with shot_update, or delete and recreate them with shot_create.',
        path: a => `/film/scenes/${a.scene_id}`,
        body: a => ({ fountain: a.fountain }),
        schema: {
            scene_id: { type: 'string' },
            fountain: { type: 'string', description: 'The complete scene in Fountain, heading first, action and dialogue beneath.' },
        },
        required: ['scene_id', 'fountain'],
    },
    {
        name: 'anchor_get',
        handler: handleProjects, method: 'GET',
        description: 'Which frame this project is currently shooting from, if any. While an anchor is set, every OTHER shot you generate is built FROM that frame \u2014 the same location, the same set dressing, the same subjects where they stand in it \u2014 re-shot on whatever lens and angle that shot\u2019s own card asks for. Plates for subjects already standing in it are not sent, since the frame has established them in situ. Exactly one anchor at a time, and none unless somebody set one.',
        path: a => `/film/projects/${a.project_id}/anchor`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'anchor_set',
        handler: handleProjects, method: 'PUT',
        description: 'Shoot from this frame. Point at the shot whose frame has the scene right \u2014 the street, the dressing, the light \u2014 and the next shots you generate keep all of it and change only the camera. Setting one REPLACES the last; the anchored shot itself still generates from its own card, since a frame built from itself could only reproduce itself. Refused if that shot has no generated frame yet. Clear it with anchor_clear when you are done working this way.',
        path: a => `/film/projects/${a.project_id}/anchor`,
        body: a => ({ shot_id: a.shot_id }),
        schema: {
            project_id: { type: 'string' },
            shot_id: { type: 'string', description: 'The shot whose generated frame to shoot from.' },
        },
        required: ['project_id', 'shot_id'],
    },
    {
        name: 'anchor_clear',
        handler: handleProjects, method: 'DELETE',
        description: 'Put the anchor down. Shots go back to generating from their own card and their subject plates.',
        path: a => `/film/projects/${a.project_id}/anchor`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'beats_get',
        handler: handleStoryStructure, method: 'GET',
        description: 'The story structure laid over this screenplay, and \u2014 the point of it \u2014 the HOLES: beats with no scene against them. Adapting a novel, that is the question worth asking: which beats have nothing yet. Each hole carries its guidance, so "you have no Midpoint" comes with what a midpoint is for. Also returns suggestions matching unlinked beats to scenes by pacing alone; they are a guess, never an assignment. SPENDS NOTHING.',
        path: a => `/film/projects/${a.project_id}/beats`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'beats_apply',
        handler: handleStoryStructure, method: 'POST',
        description: 'Lay a story framework over this screenplay: three-act, save-the-cat, heros-journey or story-circle. Creates every beat UNLINKED \u2014 linking scenes to beats is the work, and what stays unlinked is where the structure has a hole. Refuses if a beat sheet already exists unless replace is true, because two frameworks over one script is two opinions rather than a structure.',
        path: a => `/film/projects/${a.project_id}/beats`,
        body: a => ({ framework: a.framework, replace: a.replace }),
        schema: {
            project_id: { type: 'string' },
            framework: { type: 'string', description: 'three-act | save-the-cat | heros-journey | story-circle' },
            replace: { type: 'boolean', description: 'Discard an existing beat sheet and its scene links.' },
        },
        required: ['project_id', 'framework'],
    },
    {
        name: 'beat_link',
        handler: handleStoryStructure, method: 'PUT',
        description: 'Point a beat at the scene that delivers it, closing a hole \u2014 or pass scene_id null to unlink. Can also rename a beat, rewrite its guidance, move its position, or add notes: a framework is a starting shape, and a film is allowed to disagree with it.',
        path: a => `/film/beats/${a.beat_id}`,
        body: a => { const { beat_id, ...rest } = a || {}; return rest; },
        schema: {
            beat_id: { type: 'string' },
            scene_id: { type: 'string', description: 'The scene that delivers this beat. Null unlinks it.' },
            name: { type: 'string' }, guidance: { type: 'string' }, notes: { type: 'string' },
            at: { type: 'number', description: 'Where in the story it falls, 0..100.' },
        },
        required: ['beat_id'],
    },
    {
        name: 'directives_get',
        handler: handleStoryStructure, method: 'GET',
        description: 'The house rules for how THIS film is written \u2014 tense, dialogue length, whether camera directions belong in action. Read them before drafting or revising a scene. Deliberately not style_preset: that governs how frames are generated and is appended to every image prompt, so screenwriting instructions must never go there.',
        path: a => `/film/projects/${a.project_id}/directives`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'directives_write',
        handler: handleStoryStructure, method: 'PUT',
        description: 'Set the house rules for how this film is written. Governs prose, never images.',
        path: a => `/film/projects/${a.project_id}/directives`,
        body: a => ({ directives: a.directives }),
        schema: {
            project_id: { type: 'string' },
            directives: { type: 'string', description: 'e.g. "Present tense. No camera directions in action. Dialogue under three lines."' },
        },
        required: ['project_id', 'directives'],
    },
    {
        name: 'scene_card_write',
        handler: handleScenes, method: 'PUT',
        description: 'What a scene is ABOUT, beside what it says: whose point of view, what the conflict is, how it comes out. Authored metadata rather than screenplay text \u2014 writing it does NOT mark the scene as changed, so nothing generated from it is reported as behind.',
        path: a => `/film/scenes/${a.scene_id}/card`,
        body: a => { const { scene_id, ...rest } = a || {}; return rest; },
        schema: {
            scene_id: { type: 'string' },
            pov_character: { type: 'string' },
            conflict: { type: 'string', description: 'What is being fought over in this scene.' },
            outcome: { type: 'string', description: 'How it comes out, and what changes because of it.' },
        },
        required: ['scene_id'],
    },
    {
        name: 'scene_edit',
        handler: handleScenes, method: 'POST',
        description: 'Change named phrases inside ONE scene, in place. Use this instead of scene_update whenever you are altering a line rather than rewriting a scene: scene_update replaces the whole scene, so you must re-send every other line exactly and a single stray reflow marks the shots under it as behind. Each `find` must appear EXACTLY ONCE unless you pass all: true \u2014 an ambiguous match is refused rather than guessed. The batch is ALL-OR-NOTHING: if any edit cannot be applied, none are written, so a failed call leaves the scene exactly as it was. This DOES mark the scene as changed, because it is screenplay text.',
        path: a => `/film/scenes/${a.scene_id}/edit`,
        body: a => ({ edits: a.edits }),
        schema: {
            scene_id: { type: 'string' },
            edits: {
                type: 'array',
                description: '[{ find, replace, all? }]. Quote enough of the line to be unambiguous.',
            },
        },
        required: ['scene_id', 'edits'],
    },
    {
        name: 'script_stats',
        handler: handleScripts, method: 'GET',
        description: 'Length and shape of the current draft: words, pages, scenes, dialogue percentage, speaking parts, and estimated runtime (one page is roughly one minute). SPENDS NOTHING. Read it to answer "how long is this" before deciding what to cut.',
        path: a => `/film/projects/${a.project_id}/script/stats`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'scene_history',
        handler: handleScenes, method: 'GET',
        description: 'Every version this ONE scene has had, newest first, derived from the saved script versions \u2014 nothing is stored per scene, so it cannot fall out of step with the screenplay. Only versions where this scene\u2019s text actually changed are listed. SPENDS NOTHING. Use it before rewriting a scene, so a good earlier draft is recoverable rather than remembered.',
        path: a => `/film/scenes/${a.scene_id}/history`,
        schema: { scene_id: { type: 'string' } }, required: ['scene_id'],
    },
    {
        name: 'scene_restore',
        handler: handleScenes, method: 'POST',
        description: 'Put an earlier version of ONE scene back. Splices that text in as a NEW script version \u2014 forward, never backward \u2014 so every other scene and every later change survives. Read scene_history first for the version numbers.',
        path: a => `/film/scenes/${a.scene_id}/history/${a.version}/restore`,
        body: () => ({}),
        schema: {
            scene_id: { type: 'string' },
            version: { type: 'number', description: 'The script version to take this scene\u2019s text from.' },
        },
        required: ['scene_id', 'version'],
    },
    {
        name: 'outline_get',
        handler: handleScripts, method: 'GET',
        description: 'The screenplay\u2019s structure: acts and sequences (Fountain `#` sections, with depth), scene synopses (`=` lines) and the scenes, in document order. SPENDS NOTHING. Read this to see the shape of a script without pulling the whole document. Structure lives IN the Fountain, so it exports to Final Draft and travels with any copy \u2014 there is no separate outline store to fall out of step.',
        path: a => `/film/projects/${a.project_id}/outline`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'outline_write',
        handler: handleScripts, method: 'POST',
        description: 'Add a section (act/sequence heading) and/or a scene synopsis to the screenplay, above a given scene. `depth` 1..6 sets the level, so depth 1 is an act and depth 2 a sequence beneath it. These are Fountain elements written into the document, not metadata \u2014 which is why they survive export. Omit before_scene to put them at the end.',
        path: a => `/film/projects/${a.project_id}/outline`,
        body: a => ({ before_scene: a.before_scene, section: a.section, depth: a.depth, synopsis: a.synopsis }),
        schema: {
            project_id: { type: 'string' },
            section: { type: 'string', description: 'An act or sequence heading, e.g. "ACT ONE". Omit to write only a synopsis.' },
            depth: { type: 'number', description: '1..6. 1 is an act, 2 a sequence beneath it. Default 1.' },
            synopsis: { type: 'string', description: 'One line describing what follows. Omit to write only a section.' },
            before_scene: { type: 'number', description: '0-based scene position to write above. Omit for the end of the script.' },
        },
        required: ['project_id'],
    },
    {
        name: 'scene_insert_after',
        handler: handleScripts, method: 'POST',
        description: 'Insert scenes INTO the middle of the screenplay, after a given scene. `after_scene` is the scene to insert AFTER, counted the way scene_list reports them (1 is the first scene); 0 puts them before scene 1, and the scene count appends. Takes a Fountain FRAGMENT which may contain several headings. Scenes below the insertion point are renumbered in the document but each keeps its id and its text, so nothing is marked as changed and no shot is reported behind. Use this when a chapter belongs somewhere other than the end; use scene_append for the normal front-to-back import, which is cheaper.',
        path: a => `/film/projects/${a.project_id}/script/insert`,
        body: a => ({ after_scene: a.after_scene, fountain: a.fountain }),
        schema: {
            project_id: { type: 'string' },
            after_scene: {
                type: 'number',
                description: 'The scene to insert AFTER, counted the way scene_list reports them: 1 is the first scene. 0 inserts before scene 1. Read scene_list first.',
            },
            fountain: {
                type: 'string',
                description: 'A Fountain fragment starting with a scene heading. May contain several scenes.',
            },
        },
        required: ['project_id', 'after_scene', 'fountain'],
    },
    {
        name: 'scene_append',
        handler: handleScripts, method: 'POST',
        description: 'Add scenes to the END of the screenplay without re-sending it. Takes a Fountain FRAGMENT which may contain SEVERAL scene headings \u2014 send a whole chapter in one call, not one call per scene, because each call re-parses and re-reconciles the entire screenplay. This is how a novel is imported chapter by chapter: script_write would make you repost every previous chapter, which grows quadratically and risks reflowing scenes nobody edited. Everything above the appended scenes stays byte-identical, so no existing scene is marked as changed and no shot is reported behind. Refuses a fragment with no scene heading rather than burying prose inside the previous scene. Scenes are NOT broken down into shots by this \u2014 use shot_tag or shot_create for that.',
        path: a => `/film/projects/${a.project_id}/script/append`,
        body: a => ({ fountain: a.fountain }),
        schema: {
            project_id: { type: 'string' },
            fountain: {
                type: 'string',
                description: 'A Fountain fragment starting with a scene heading (INT./EXT., or a line beginning with a full stop). May contain several scenes \u2014 one chapter per call.',
            },
        },
        required: ['project_id', 'fountain'],
    },
    {
        name: 'shot_list',
        handler: handleShots, method: 'GET',
        description: 'The full shot list with each shot\u2019s scene card.',
        path: a => `/film/projects/${a.project_id}/shotlist`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'shot_create',
        handler: handleShots, method: 'POST',
        description: 'Create shots for one scene from an array of scene cards. Each card needs shot_code plus camera {shot_type, movement, lens}, lighting {type}, description, duration_seconds, and characters/dialogue where present. Name every character that appears — that is how their appearance reaches the prompt.',
        path: () => '/film/shots',
        body: a => ({ scene_id: a.scene_id, cards: a.cards }),
        schema: {
            scene_id: { type: 'string' },
            cards: { type: 'array', description: 'Scene card objects.', items: { type: 'object' } },
        },
        required: ['scene_id', 'cards'],
    },
    {
        name: 'entities_create',
        handler: handleScripts, method: 'POST',
        description: 'Create every character, location and prop the screenplay introduces, in one call. A parsed screenplay creates NO entity rows on its own, so without this an agent can describe entities it has no way to bring into existence. Includes characters introduced in action who never speak — the creature, the corpse, the double — which dialogue-cue detection misses. Idempotent on name: safe to re-run after a script revision. Pass props explicitly; they come from reading the action, not from a pattern.',
        path: a => `/film/projects/${a.project_id}/screenplay/suggestions/apply`,
        body: a => {
            const { project_id, ...rest } = a || {};
            return rest;
        },
        schema: {
            project_id: { type: 'string' },
            props: { type: 'array', description: 'Props read out of the action: [{ name, visual_prompt, category }]' },
            characters: { type: 'array', description: 'Override detection: [{ name, appearance_prompt, age_range }]' },
            locations: { type: 'array', description: 'Override detection: [{ name, description, lighting_default }]' },
        },
        required: ['project_id'],
    },
    {
        name: 'previs_get',
        handler: handlePrevis, method: 'GET',
        description: 'Read a shot\'s 3D blocking: camera position, lens, sensor, rig, movement and the sampled path. Also returns the shot\'s generated keyframe (so it can stand in the stage as a reference card) and its approval state.',
        path: a => `/film/shots/${a.shot_id}/previs`,
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'previs_from_card',
        handler: handlePrevis, method: 'POST',
        description: 'Seed the 3D stage from what the scene card already says — shot type, lens, movement — instead of retyping it. Start here when exploring a shot. Refuses to clobber existing blocking unless overwrite is set.',
        path: a => `/film/shots/${a.shot_id}/previs/from-card`,
        body: a => ({ overwrite: !!a.overwrite }),
        schema: {
            shot_id: { type: 'string' },
            overwrite: { type: 'boolean', description: 'Replace hand-made blocking. Off by default.' },
        },
        required: ['shot_id'],
    },
    {
        name: 'previs_solve',
        handler: handlePrevis, method: 'POST',
        description: 'Work out where the camera must stand for a given framing on a given lens — "close-up on a 50" becomes a distance in metres, with field of view and depth of field. Solves only; does not save.',
        path: a => `/film/shots/${a.shot_id}/previs/solve`,
        body: a => { const { shot_id, ...rest } = a || {}; return rest; },
        schema: {
            shot_id: { type: 'string' },
            shot_type: { type: 'string', description: 'close-up, medium, wide, two-shot, over-the-shoulder, low-angle, high-angle, …' },
            focal_mm: { type: 'number' },
            f_stop: { type: 'number' },
            sensor_id: { type: 'string', description: 'super35, full-frame, …' },
            rig: { type: 'string', description: 'dolly, crane, steadicam, handheld, …' },
        },
        required: ['shot_id', 'shot_type'],
    },
    {
        name: 'previs_set',
        handler: handlePrevis, method: 'PUT',
        description: 'Save staged blocking and director intent for a shot: camera optics/position, subjects, stage, rig, movement, plus director {direction,location_view,lighting,camera_note}. This is exploratory and does NOT change the Shot Board until previs_apply. Preview freely with previs_to_storyboard before committing.',
        path: a => `/film/shots/${a.shot_id}/previs`,
        body: a => { const { shot_id, ...rest } = a || {}; return rest; },
        schema: {
            shot_id: { type: 'string' },
            camera: { type: 'object', description: '{ position:[x,y,z], rotation:[x,y,z], focalMm, sensorId, fStop, focusDistanceM }' },
            subject: { type: 'object', description: '{ position:[x,y,z], heightM }' },
            stage: { type: 'object' },
            rig: { type: 'string' },
            movement: { type: 'string' },
            subjects: { type: 'array', description: 'Staged objects: figures, boxes, image cards.' },
            director: { type: 'object', description: '{ direction, location_view, lighting:{type,notes}, camera_note }. Saved as staged intent; apply explicitly.' },
        },
        required: ['shot_id'],
    },
    {
        name: 'previs_to_storyboard',
        handler: handlePrevis, method: 'POST',
        description: 'Preview the exact image payload this staged blocking and director intent would generate, WITHOUT applying, generating or spending. The response says staged/applied explicitly; use it between angles before committing.',
        path: a => `/film/shots/${a.shot_id}/previs/to-storyboard`,
        body: a => ({ ignore_approval: !!a.ignore_approval }),
        schema: {
            shot_id: { type: 'string' },
            ignore_approval: { type: 'boolean', description: 'Generate even though the blocking changed after it was approved.' },
        },
        required: ['shot_id'],
    },
    {
        name: 'previs_apply',
        handler: handlePrevis, method: 'POST',
        description: 'Commit staged Previs intent to the scene card: framing, lens, movement, sensor, aperture, focus distance, height, direction, background view, lighting, and named subjects. Screenplay description and dialogue survive. Do this only when the explored angle is the one to keep.',
        path: a => `/film/shots/${a.shot_id}/previs/apply`,
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'previs_approve',
        handler: handlePrevis, method: 'POST',
        description: 'Sign off the blocking as it stands. Stores a fingerprint of the camera and card, so if the shot is restaged afterwards, generation refuses with 409 STALE_APPROVAL rather than shooting a frame nobody approved. This is what "I am happy with this angle" means to the pipeline.',
        path: a => `/film/shots/${a.shot_id}/previs/approve`,
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'artefact_accept',
        handler: handleProductionReports, method: 'POST',
        description: 'Mark a generated artefact as still correct for its current inputs, WITHOUT regenerating it. Use this when staleness_report flags something whose output is still good \u2014 a description can be rewritten in ways a plate still satisfies, and regenerating spends money to replace an image someone chose, with no guarantee of reproducing it.',
        path: a => `/film/assets/${a.asset_id}/accept`,
        body: a => (a.kind ? { kind: a.kind } : {}),
        schema: {
            asset_id: { type: 'string' },
            kind: { type: 'string', description: 'Only needed if the asset has no recorded artefact kind.' },
        },
        required: ['asset_id'],
    },
    {
        name: 'scale_check',
        handler: handleProductionReports, method: 'GET',
        description: 'Which characters and props have no declared size, and how many shots each appears in. An image model has no sense of scale, and a reference plate makes it WORSE — a plate is a close-up filling its own frame, so conditioning on one without a size reproduces what it was shown, which is how a 30cm sprinkler comes out the size of a car. Run this before generating and fill every gap with character_update / prop_update.',
        path: a => `/film/projects/${a.project_id}/scale-check`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'impact_report',
        handler: handleProductionReports, method: 'GET',
        description: 'What one change has broken, all the way down the chain: screenplay to scene card to keyframe to clip to lip-sync to post. Run it after ANY change and before generating anything. Each stage is either "redo" — out of date with everything it is built from current, so do it now — or "waiting", meaning it is only out of date because something above it is, and regenerating it now would build on the same old inputs and cost money to produce something still wrong. Do the redo items first, top to bottom.',
        path: a => `/film/projects/${a.project_id}/impact`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'screenplay_drift',
        handler: handleProductionReports, method: 'GET',
        description: 'Which shots were written from an EARLIER draft of their scene, and what has been generated from them. Run this after any screenplay change: revising a scene does not update the shot cards derived from it, so those cards keep describing the previous story with nothing to show for it. Reports per scene with the next action for each. Warns only — nothing is blocked.',
        path: a => `/film/projects/${a.project_id}/screenplay-drift`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'screenplay_baseline',
        handler: handleProductionReports, method: 'POST',
        description: 'Record every shot that has no draft recorded as matching the screenplay AS IT STANDS NOW. Run this once on a project that predates drift tracking, and only when you believe the current cards do describe the current script — it is a claim about the work, not a cleanup. Shots already known to be behind are left alone.',
        path: a => `/film/projects/${a.project_id}/screenplay-drift/baseline`,
        body: () => ({}),
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'spend_report',
        handler: handleBudget, method: 'GET',
        description: 'What this project has actually cost in AI generation \u2014 dollars, and the provider units underneath them (tokens at Anthropic, credits at Meshy and Runway, characters and seconds at ElevenLabs). Broken down by capability, provider, model, day and shot, with cost per minute of finished footage and cost per shot. Spend is recorded automatically at the moment of every provider call; nothing needs to be entered by hand. `estimated_usd` is the part that was reconstructed from assets generated before tracking existed \u2014 a floor, since failed generations cost money and left nothing to count. This is NOT the live-action budget estimator (budget_estimate): that one prices crew, cast and shooting days, which this pipeline does not have.',
        path: a => `/film/projects/${a.project_id}/spend`,
        schema: { project_id: { type: 'string' } },
        required: ['project_id'],
    },
    {
        name: 'spend_usage',
        handler: handleBudget, method: 'GET',
        description: 'The raw meter: one row per provider call, with the units consumed, the rate applied and what it cost. Use it to answer "why is this number what it is" \u2014 spend_report aggregates, this shows the calls. Filter by capability or provider.',
        path: a => {
            const q = [];
            if (a.capability) q.push(`capability=${encodeURIComponent(a.capability)}`);
            if (a.provider) q.push(`provider=${encodeURIComponent(a.provider)}`);
            if (a.limit) q.push(`limit=${encodeURIComponent(a.limit)}`);
            return `/film/projects/${a.project_id}/spend/usage${q.length ? '?' + q.join('&') : ''}`;
        },
        schema: {
            project_id: { type: 'string' },
            capability: { type: 'string', description: 'image, video, voice, music, sfx, ambient, llm, model3d, lipsync, post' },
            provider: { type: 'string', description: 'anthropic, meshy, elevenlabs, runway, openai, gridlight' },
            limit: { type: 'number' },
        },
        required: ['project_id'],
    },
    {
        name: 'spend_backfill',
        handler: handleBudget, method: 'POST',
        description: 'Reconstruct what a project spent BEFORE metering existed, by pricing the assets it already has. Every keyframe, plate, clip and audio file on record is one generation someone paid for, and the project provider config says who was paid. Idempotent \u2014 each asset is reconstructed once, so running it twice cannot double the history. Everything it writes is flagged as an estimate and reported separately from measured spend. Pass dry_run to see the number without writing it. It is a FLOOR: a generation that failed cost money and left no asset behind.',
        path: a => `/film/projects/${a.project_id}/spend/backfill`,
        body: a => ({ dry_run: !!a.dry_run }),
        schema: {
            project_id: { type: 'string' },
            dry_run: { type: 'boolean', description: 'Price it without recording it.' },
        },
        required: ['project_id'],
    },
    {
        name: 'spend_rates',
        handler: handleBudget, method: 'GET',
        description: 'The rate book every cost is priced from: per provider and capability, the billing unit, the provider-native unit (usually credits), the USD rate, the published source URL and the date it was checked. Meshy publishes credit costs but not what a credit costs, so its dollar figure is the Pro-plan rate and can be corrected per install; a rate marked inferred was not in the published table and inherits its tier.',
        path: () => '/film/spend/rates',
        schema: {},
        required: [],
    },
    {
        name: 'staleness_accept',
        handler: handleProductionReports, method: 'POST',
        path: a => `/film/projects/${a.project_id}/staleness/accept`,
        body: a => (a.kinds ? { kinds: a.kinds } : {}),
        description:
            'Record every stamped artefact in a project as STILL CURRENT for the inputs it has now. '
            + 'FREE \u2014 nothing is regenerated and nothing is spent. Use when the staleness report '
            + 'is full of work that is genuinely still the film you want: improvements to how prompts '
            + 'are built move every fingerprint, so a real project can report seventy artefacts behind '
            + 'while every one of them is fine. This is a CLAIM that the work still stands \u2014 if a '
            + 'subject or a card really did change, regenerate that one instead of accepting it. '
            + 'Unstamped assets are untouched. Optionally limit to certain kinds.',
        schema: {
            project_id: { type: 'string' },
            kinds: { type: 'array', description: 'Limit to these artefact kinds, e.g. ["keyframe"]. Omit for all.' },
        },
        required: ['project_id'],
    },
    {
        name: 'staleness_report',
        handler: handleProductionReports, method: 'GET',
        description: 'Which generated artefacts no longer match the inputs they were made from. Run this BEFORE generating: a frame built from an old character description or an old plate looks valid forever and nothing else will tell you. Reports stale (inputs changed), fresh (verified current) and unknown (generated before fingerprinting existed \u2014 not a claim either way).',
        path: a => `/film/projects/${a.project_id}/staleness`,
        schema: { project_id: { type: 'string' } },
        required: ['project_id'],
    },
    {
        name: 'run_plan',
        handler: handleProductionReports, method: 'GET',
        description: 'What a generation run would do, in what order, and what it would cost \u2014 BEFORE spending anything. Skips work that is already current, so re-running after a small edit costs a small amount. order=model loads each model once (cheapest, nothing finished until the end); order=shot walks one shot through every step (a finished shot early, at the cost of reloading models per shot). Returns HTTP 402 and refused:true when the projected cost would exceed the project budget.',
        path: a => {
            const q = [];
            if (a.order) q.push(`order=${encodeURIComponent(a.order)}`);
            if (a.ignore_budget) q.push('ignore_budget=true');
            return `/film/projects/${a.project_id}/run-plan${q.length ? '?' + q.join('&') : ''}`;
        },
        schema: {
            project_id: { type: 'string' },
            order: { type: 'string', description: '"model" (default) or "shot".' },
            ignore_budget: { type: 'boolean', description: 'Plan anyway when it would exceed the budget.' },
        },
        required: ['project_id'],
    },
    {
        name: 'board_groups',
        handler: handleProductionReports, method: 'GET',
        description: 'Read the storyboard grouped by scene, location or time of day instead of as a flat grid. Every frame lands in exactly one group; frames missing the axis value collect under an explicit "(no location)" rather than vanishing.',
        path: a => `/film/projects/${a.project_id}/board-groups${a.axis ? `?axis=${encodeURIComponent(a.axis)}` : ''}`,
        schema: {
            project_id: { type: 'string' },
            axis: { type: 'string', description: 'scene | location | time_of_day' },
        },
        required: ['project_id'],
    },
    {
        name: 'setups',
        handler: handleProductionReports, method: 'GET',
        description: 'Shots grouped into setups \u2014 same location, framing and lens, so they reuse the same plate and look. On a set you group by camera position because MOVING costs; here nothing moves, so the cost is conditioning, and this is what makes a run cheap and a look consistent. `reused_shots` is how much of the board rides on another shot\u2019s setup.',
        path: a => `/film/projects/${a.project_id}/setups`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'shot_annotate',
        handler: handleAnnotations, method: 'POST',
        description: 'Draw a note on a storyboard frame: arrow, line, rect, ellipse, freehand or text. Geometry is NORMALISED \u2014 points are [[x,y],...] with x and y between 0 and 1 of the frame \u2014 so markup survives the frame being regenerated at another size. Attached to the shot, not the image, so regenerating does not erase the note that asked for it. ALWAYS pass `text`: geometry says where, never what, so a mark with no note can be drawn and read by a person but cannot reach a prompt. Whether noted marks reach the prompt at all is the project\u2019s annotation_feedback, off by default; storyboard_regenerate and storyboard_refine take use_annotations to apply them for one call.',
        path: a => `/film/shots/${a.shot_id}/annotations`,
        body: a => { const { shot_id, ...rest } = a || {}; return rest; },
        schema: {
            shot_id: { type: 'string' },
            kind: { type: 'string', description: 'arrow | line | rect | ellipse | freehand | text' },
            points: { type: 'array', description: '[[x,y], ...] normalised 0..1.' },
            text: { type: 'string', description: 'Required for a text note.' },
        },
        required: ['shot_id', 'kind', 'points'],
    },
    {
        name: 'mood_board_add',
        handler: handleMoodBoard, method: 'POST',
        description: 'Add a reference to the look board: kind is palette, lighting, lens, framing, texture or image, and `note` is the words that will reach the style preset. Assemble the look here BEFORE generating \u2014 the board composes into the style preset, which is appended to every image prompt in the production.',
        path: a => `/film/projects/${a.project_id}/mood-board`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            project_id: { type: 'string' },
            kind: { type: 'string', description: 'palette | lighting | lens | framing | texture | image' },
            note: { type: 'string', description: 'The words that reach the style preset.' },
            image_path: { type: 'string' },
        },
        required: ['project_id'],
    },
    {
        name: 'mood_board_compose',
        handler: handleMoodBoard, method: 'POST',
        description: 'Compose the board into a style preset and check it. Returns the composed string WITHOUT applying it \u2014 pass apply:true to commit. Two warnings: `subject` when the board names a thing rather than a look (a style is appended to every prompt, so a creature named here is drawn into frames nobody wrote it into), and `length` when the style exceeds what a prompt can carry. `effective_style` is what a provider would actually receive \u2014 check it, because a long style is trimmed and most of it never arrives.',
        path: a => `/film/projects/${a.project_id}/mood-board/compose`,
        body: a => ({ apply: !!a.apply }),
        schema: {
            project_id: { type: 'string' },
            apply: { type: 'boolean', description: 'Write the composed style onto the project.' },
        },
        required: ['project_id'],
    },
    {
        name: 'shot_tag',
        handler: handleComments, method: 'POST',
        description: 'Turn selected screenplay lines into shots. The line becomes the shot description verbatim \u2014 nothing is paraphrased on the way \u2014 and the characters named in it are captured onto the card, including ones who never speak. Only action and dialogue lines become shots; sluglines and transitions are refused. Idempotent per line: tagging the same line twice does not make two shots. Get element ids from script_get.',
        path: a => `/film/scripts/${a.script_id}/tag`,
        body: a => ({ element_ids: a.element_ids || [] }),
        schema: {
            script_id: { type: 'string' },
            element_ids: { type: 'array', description: 'Ids of the script elements to turn into shots.' },
        },
        required: ['script_id', 'element_ids'],
    },
    {
        name: 'breakdown_summary',
        handler: handleProductionReports, method: 'GET',
        description: 'What each scene contains, scene by scene: characters, props, shot count, dialogue lines, duration. The document a first AD reads, answering which subjects a scene commits you to.',
        path: a => `/film/projects/${a.project_id}/breakdown-summary`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'elements_list',
        handler: handleProductionReports, method: 'GET',
        description: 'Every element grouped by type (characters, locations, props) with the scene count for each. `undescribed` is the actionable line: an element with no description reaches generation as a bare name, and every frame then invents its own version of it.',
        path: a => `/film/projects/${a.project_id}/elements-list`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'run_report',
        handler: handleProductionReports, method: 'GET',
        description: 'What recent generation runs did: status, failed steps named individually, and recorded spend against budget. This is the call sheet reinterpreted \u2014 there is no crew to notify, but a director still needs to know whether the day happened and what went wrong. Read it after a run.',
        path: a => `/film/projects/${a.project_id}/run-report${a.limit ? `?limit=${encodeURIComponent(a.limit)}` : ''}`,
        schema: {
            project_id: { type: 'string' },
            limit: { type: 'number', description: 'How many recent runs to report (default 10, max 50).' },
        },
        required: ['project_id'],
    },
    {
        name: 'sides_report',
        handler: handleProductionReports, method: 'GET',
        description: 'Each character\u2019s own lines, scene by scene \u2014 what a director reviews before spending on voice generation. Characters with no dialogue are listed with line_count 0 rather than omitted, so "has no lines" is distinguishable from "is not in this film".',
        path: a => `/film/projects/${a.project_id}/sides`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'dood_report',
        handler: handleProductionReports, method: 'GET',
        description: 'Day-out-of-days: which scenes and how many shots each character is committed to, and whether it has a reference plate yet. `needs_plate` is the actionable half \u2014 a character in 40 shots with no plate is 40 frames that will each invent their own version of them.',
        path: a => `/film/projects/${a.project_id}/dood`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'character_create',
        handler: handleCharacters, method: 'POST',
        description: 'Create one character. Fill appearance_prompt at the same time: a character row with an empty appearance_prompt reaches the image prompt as a bare name, and every frame then invents its own person.',
        path: a => `/film/projects/${a.project_id}/characters`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            height_m: { type: 'number', description: 'Height in metres, e.g. 1.7.' },
            project_id: { type: 'string' },
            name: { type: 'string' },
            appearance_prompt: { type: 'string', description: 'What this person looks like, in prompt terms.' },
            description: { type: 'string' },
            age_range: { type: 'string' },
        },
        height_m: { type: 'number', description: 'Height in metres, e.g. 1.7.' },
            required: ['project_id', 'name'],
    },
    {
        name: 'location_create',
        handler: handleLocations, method: 'POST',
        description: 'Create one location with a real description. Do not write "EXT location (3 mentions)" — that placeholder used to reach image prompts as though it described a place.',
        path: a => `/film/projects/${a.project_id}/locations`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            project_id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string', description: 'What the place looks like: period, materials, wear, light.' },
            lighting_default: { type: 'string' },
        },
        required: ['project_id', 'name'],
    },
    {
        name: 'prop_create',
        handler: handleLocations, method: 'POST',
        description: 'Create one prop. visual_prompt is what reaches the image prompt and what a prop plate is generated from.',
        path: a => `/film/projects/${a.project_id}/props`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            height_m: { type: 'number', description: 'Height in metres. Required in practice: nothing else tells the model how big this is.' },
            width_m: { type: 'number', description: 'Width in metres.' },
            length_m: { type: 'number', description: 'Length in metres.' },
            project_id: { type: 'string' },
            name: { type: 'string' },
            visual_prompt: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string' },
        },
        height_m: { type: 'number', description: 'Height in metres.' },
            width_m: { type: 'number', description: 'Width in metres.' },
            required: ['project_id', 'name'],
    },
    {
        name: 'character_delete',
        handler: handleCharacters, method: 'DELETE',
        description: 'Remove a character. Anything generated for it \u2014 reference plates, voice \u2014 goes with it. Use this to undo a character you created by mistake, rather than leaving a duplicate for a human to clean up.',
        path: a => `/film/characters/${a.character_id}`,
        schema: { character_id: { type: 'string' } }, required: ['character_id'],
    },
    {
        name: 'location_delete',
        handler: handleLocations, method: 'DELETE',
        description: 'Remove a location and anything generated for it, including its plate.',
        path: a => `/film/locations/${a.location_id}`,
        schema: { location_id: { type: 'string' } }, required: ['location_id'],
    },
    {
        name: 'prop_list',
        handler: handleLocations, method: 'GET',
        description: 'List props with their ids and visual_prompt. Needed before prop_update or prop_delete \u2014 both take an id, and without this there is no way to learn one.',
        path: a => `/film/projects/${a.project_id}/props`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'mood_board_list',
        handler: handleMoodBoard, method: 'GET',
        description: 'List every entry on the look board with its id, kind, note and spec. Needed before mood_board_remove, which takes an entry_id \u2014 without this an agent can only remove entries it created itself in the same session.',
        path: a => `/film/projects/${a.project_id}/mood-board`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'annotation_list',
        handler: handleAnnotations, method: 'GET',
        description: 'List the markup notes on a storyboard frame with their ids. Needed before annotation_delete. Also reports, per mark, whether it reaches the next prompt and why not \u2014 a mark with no note says where but not what, and a project with annotation_feedback off treats all markup as notation for a human.',
        path: a => `/film/shots/${a.shot_id}/annotations`,
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'prop_update',
        handler: handleLocations, method: 'PUT',
        description: 'Change a prop. visual_prompt is the field that reaches the image prompt and that a prop plate is generated from. Use this rather than prop_create when the prop already exists \u2014 creating one twice is refused.',
        path: a => `/film/props/${a.prop_id}`,
        body: a => { const { prop_id, ...rest } = a || {}; return rest; },
        schema: {
            height_m: { type: 'number', description: 'Height in metres.' },
            width_m: { type: 'number', description: 'Width in metres.' },
            length_m: { type: 'number', description: 'Length in metres.' },
            bible_section: { type: 'string', description: 'The story bible section these words were written from.' },
            prop_id: { type: 'string' },
            visual_prompt: { type: 'string', description: 'What this object looks like, in prompt terms.' },
            description: { type: 'string' },
            category: { type: 'string' },
            name: { type: 'string' },
        },
            required: ['prop_id'],
    },
    {
        name: 'prop_delete',
        handler: handleLocations, method: 'DELETE',
        description: 'Remove a prop and anything generated for it.',
        path: a => `/film/props/${a.prop_id}`,
        schema: { prop_id: { type: 'string' } }, required: ['prop_id'],
    },
    {
        name: 'shot_delete',
        handler: handleShots, method: 'DELETE',
        description: 'Remove a shot. Reports assets_affected \u2014 a shot can carry generated frames and clips that cost money to make, so check that number before assuming this was cheap.',
        path: a => `/film/shots/${a.shot_id}`,
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'mood_board_remove',
        handler: handleMoodBoard, method: 'DELETE',
        description: 'Remove one entry from the look board. Compose again afterwards \u2014 the style is rebuilt from what remains, so removing an entry changes it.',
        path: a => `/film/mood-board/${a.entry_id}`,
        schema: { entry_id: { type: 'string' } }, required: ['entry_id'],
    },
    {
        name: 'annotation_delete',
        handler: handleAnnotations, method: 'DELETE',
        description: 'Remove one markup note from a storyboard frame.',
        path: a => `/film/annotations/${a.annotation_id}`,
        schema: { annotation_id: { type: 'string' } }, required: ['annotation_id'],
    },
    {
        name: 'character_list',
        handler: handleCharacters, method: 'GET',
        description: 'List characters. A newly parsed screenplay leaves appearance_prompt EMPTY — check this before generating anything.',
        path: a => `/film/projects/${a.project_id}/characters`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'character_update',
        handler: handleCharacters, method: 'PUT',
        description: 'Describe a character so every frame draws the same person. appearance_prompt is the field that reaches the image prompt: age, build, hair, wardrobe, distinguishing features.',
        path: a => `/film/characters/${a.character_id}`,
        body: a => {
            const { character_id, ...rest } = a || {};
            return rest;
        },
        schema: {
            height_m: { type: 'number', description: 'Height in metres, e.g. 1.7. Nothing else tells the model how big this character is.' },
            bible_section: { type: 'string', description: 'The story bible section these words were written from.' },
            character_id: { type: 'string' },
            appearance_prompt: { type: 'string', description: 'What this person looks like, in prompt terms.' },
            description: { type: 'string' },
            age_range: { type: 'string' },
        },
            required: ['character_id'],
    },
    {
        name: 'location_list',
        handler: handleLocations, method: 'GET',
        description: 'List locations with their lighting defaults.',
        path: a => `/film/projects/${a.project_id}/locations`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'location_update',
        handler: handleLocations, method: 'PUT',
        description: 'Describe a location so every scene set there looks like the same place — architecture, palette, era, condition.',
        path: a => `/film/locations/${a.location_id}`,
        body: a => {
            const { location_id, ...rest } = a || {};
            return rest;
        },
        schema: {
            bible_section: { type: 'string', description: 'The story bible section these words were written from.' },
            location_id: { type: 'string' },
            description: { type: 'string', description: 'What this place looks like, in prompt terms.' },
            lighting_default: { type: 'string' },
        },
            required: ['location_id'],
    },
    {
        name: 'storyboard_generate',
        handler: handleStoryboard, method: 'POST',
        description: 'Generate a keyframe for every shot. Run this only AFTER characters and locations are described, or each frame invents its own.',
        path: a => `/film/projects/${a.project_id}/storyboard/generate`,
        body: () => ({}),
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'script_write',
        handler: handleScripts, method: 'POST',
        description: 'Save a NEW version of the screenplay from Fountain source. This is how a story is revised: read it with script_get, rewrite it whole, save it back. Versioned, so the previous draft is kept. By default it RECONCILES scenes — matching by number then location, updating what changed, adding what is new — so existing shots and their generated frames survive. Shots are NOT re-derived: a scene whose story changed still holds the old shot cards, so fix them with shot_update, or delete them with shot_delete and re-derive that one scene with breakdown_run.',
        path: a => `/film/projects/${a.project_id}/script`,
        body: a => ({
            fountain_content: a.fountain_content,
            title: a.title,
            // Reconcile unless the caller explicitly asks to start over. The
            // destructive path cascades through film_shots and takes the whole
            // production with it, which is never what a revision means.
            sync_scenes: a.replace_everything !== true,
            replace_scenes: a.replace_everything === true,
        }),
        schema: {
            project_id: { type: 'string' },
            fountain_content: { type: 'string', description: 'The COMPLETE screenplay in Fountain markup, not a patch. Scene headings as INT./EXT. LOCATION - TIME.' },
            title: { type: 'string' },
            replace_everything: {
                type: 'boolean',
                description: 'DESTRUCTIVE. Deletes every scene and, by cascade, every shot, scene card, blocking and annotation in the project, then rebuilds scenes from this draft. Only for starting a project over. Never use this to revise a story.',
            },
        },
        required: ['project_id', 'fountain_content'],
    },
    {
        name: 'shot_get',
        handler: handleShots, method: 'GET',
        description: 'Read one shot: its scene card, and the screenplay text the card was derived from. ONLY the card reaches the image prompt, so anything in scene_text the card does not restate will not appear in the frame — read both before editing.',
        path: a => `/film/shots/${a.shot_id}`,
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'shot_update',
        handler: handleShots, method: 'PUT',
        description: 'Edit a shot\u2019s scene card. MERGES: send only the fields you are changing and the rest survive. Use card_vocabulary for the values camera.shot_type, camera.movement and lighting.type accept. Anything already generated from this card becomes stale.',
        path: a => `/film/shots/${a.shot_id}`,
        body: a => {
            const { shot_id, ...rest } = a || {};
            return rest;
        },
        schema: {
            shot_id: { type: 'string' },
            description: { type: 'string', description: 'What the SCREENPLAY says this shot is. The writing, and the source a board is built from — revising the story replaces this half.' },
            direction: { type: 'string', description: 'What the DIRECTOR adds on top of the writing: how it is played, what to emphasise. Kept separate from description so a script revision can replace its own half without discarding this. Leads nothing — the screenplay leads and this modifies it.' },
            action: { type: 'string' },
            camera: { type: 'object', description: '{shot_type, movement, lens} — lens is free text ("40mm anamorphic").' },
            lighting: { type: 'object', description: '{type, notes}' },
            characters: { type: 'array', items: { type: 'string' }, description: 'Everyone in the shot, by name. This is how their appearance reaches the prompt.' },
            props: { type: 'array', items: { type: 'string' }, description: 'Objects in the shot, by name. A prop named here attaches its plate.' },
            dialogue: { type: 'array', items: { type: 'object' } },
            sfx_cues: { type: 'array', description: 'Sound effects this shot needs.' },
            location_view: { type: 'string', description: 'Which SIDE of the scene’s location this shot looks at — read plate_view_list first, because a name matching no view falls back to the default plate silently, and the default is a photograph of what is behind this camera.' },
            duration_seconds: { type: 'number' },
            notes: { type: 'string' },
        },
        required: ['shot_id'],
    },
    {
        name: 'card_vocabulary',
        handler: handleShots, method: 'GET',
        description: 'The values a scene card may use for camera.shot_type, camera.movement and lighting.type. Read this before writing a card — a value outside these lists is refused by the validator.',
        path: () => '/film/card-vocabulary',
        schema: {}, required: [],
    },
    {
        name: 'shot_prompt',
        handler: handleStoryboard, method: 'GET',
        description: 'What this shot WOULD send to the image model, and how much room is left. Returns the assembled prompt, the provider ceiling, the headroom, which plates are attached as images, and every locked subject with how many characters it wrote and how many survived. SPENDS NOTHING, and reports the shot\u2019s markup under `direction` \u2014 which marks would reach the prompt, which carry no note and therefore cannot, and the exact clause they produce. Read it before regenerating anything: the engine can hold a ceiling but cannot decide what matters, and a description cut at a clause boundary does not know that "one wheel trim missing" is worth more than "cracked tan vinyl".',
        path: a => {
            const q = [];
            if (a.direction_mode) q.push(`direction_mode=${encodeURIComponent(a.direction_mode)}`);
            if (a.use_annotations !== undefined) q.push(`use_annotations=${a.use_annotations ? 'true' : 'false'}`);
            return `/film/shots/${a.shot_id}/prompt` + (q.length ? `?${q.join('&')}` : '');
        },
        schema: {
            shot_id: { type: 'string' },
            // Both of these were reachable on the route and unreachable from
            // here, which made this tool unable to preview the two things most
            // worth previewing \u2014 and this tool spends nothing, so a mode you
            // cannot dry-run is one you can only try by paying for it.
            direction_mode: {
                type: 'string',
                description: '"action" (default) or "camera". Preview what locking the scene to the anchor '
                    + 'would do to the prompt before paying for it: camera mode collapses the anchored '
                    + 'subjects to their names and spends the room on the camera instead.',
            },
            use_annotations: {
                type: 'boolean',
                description: 'Preview the prompt with the shot\u2019s noted markup folded in, whatever the '
                    + 'project setting.',
            },
        }, required: ['shot_id'],
    },
    {
        name: 'shot_frames',
        handler: handleStoryboard, method: 'GET',
        description: 'Every attempt at this shot\u2019s keyframe, newest first, with which one is currently on the board. Regeneration overwrites the live frame but the outgoing picture is archived, so nothing generated is ever lost \u2014 and generation is a coin flip you already paid for, so an earlier attempt is often the one you wanted. SPENDS NOTHING.',
        path: a => `/film/shots/${a.shot_id}/frames`,
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'shot_frame_restore',
        handler: handleStoryboard, method: 'POST',
        description: 'Put an earlier attempt back on the board. Copies that version to the live frame as a NEW version \u2014 nothing is deleted and nothing is rewound, so the attempt you are leaving is still there if you change your mind again. Costs nothing: it is a file copy, not a generation. Read shot_frames first for the version numbers.',
        path: a => `/film/shots/${a.shot_id}/frames/${a.version}/restore`,
        body: () => ({}),
        schema: {
            shot_id: { type: 'string' },
            version: { type: 'number', description: 'The version to put back, from shot_frames.' },
        },
        required: ['shot_id', 'version'],
    },
    {
        name: 'storyboard_recompose',
        handler: handleStoryboard, method: 'POST',
        description: 'Keep the PERFORMANCE from one frame and replace its BACKGROUND with a photographed '
            + 'view of the shot\u2019s location. Use this when the acting, framing and camera are right '
            + 'and the place behind them is wrong \u2014 storyboard_refine cannot do it, because its '
            + 'contract refuses composition changes and on a close-up the background IS most of the '
            + 'composition. Two references travel in ORDER: the frame first, the background view second. '
            + 'The background must be a view of this shot\u2019s own location; photograph one first if the '
            + 'angle you need does not exist. Costs credits.',
        path: a => `/film/shots/${a.shot_id}/storyboard/recompose`,
        body: a => ({
            from_version: a.from_version,
            background_asset_id: a.background_asset_id,
            background_view: a.background_view,
            instruction: a.instruction,
        }),
        schema: {
            shot_id: { type: 'string' },
            from_version: {
                type: 'number',
                description: 'Which kept version supplies the performance. Omit for the frame the shot '
                    + 'currently shows.',
            },
            background_asset_id: {
                type: 'string',
                description: 'The location view to put behind them. Canonical; get it from the location\u2019s '
                    + 'views. Must belong to this shot\u2019s location.',
            },
            background_view: {
                type: 'string',
                description: 'The view by NAME instead of id, e.g. "from the far kerb, looking back across '
                    + 'the bulb". Convenience; the id is exact.',
            },
            instruction: {
                type: 'string',
                description: 'Optional, additive. The performance, framing and wardrobe are already held '
                    + 'and the light and grade already come from the background \u2014 say something only '
                    + 'if you want it ON TOP of that.',
            },
        },
        required: ['shot_id'],
    },
    {
        name: 'storyboard_refine',
        handler: handleStoryboard, method: 'POST',
        description: 'Keep an existing frame and change ONE thing about it. Sends the picture itself plus a single instruction — no scene card, no subject descriptions, no style preset, because the picture already carries all of that and repeating it in words pulls the result back toward a fresh generation. Use this instead of storyboard_regenerate whenever the composition is right and one element is wrong: "remove the sprinkler", "move the car to the kerb". Pass version to refine an earlier attempt rather than the current frame. Costs credits.',
        path: a => `/film/shots/${a.shot_id}/storyboard/refine`,
        body: a => ({ instruction: a.instruction, version: a.version, use_annotations: a.use_annotations, use_anchor: a.use_anchor }),
        schema: {
            shot_id: { type: 'string' },
            use_anchor: {
                type: 'boolean',
                description: 'Attach the project\u2019s anchor frame as a SECOND reference, so this refine '
                    + 'can be made continuous with a scene it cannot otherwise see \u2014 same location, set '
                    + 'dressing, time of day and grade, without copying its composition. Off by default: '
                    + 'refine means "keep this picture", and a second image arriving uninvited is what pulls '
                    + 'a refine back toward a fresh generation. Refused if no anchor has a frame.',
            },
            shot_id: { type: 'string' },
            instruction: { type: 'string', description: 'The one change, in a sentence. Everything else is kept.' },
            version: { type: 'number', description: 'Refine this stored version instead of the current frame.' },
            use_annotations: {
                type: 'boolean',
                description: 'Apply the shot\u2019s markup as part of the instruction, whatever the project setting. '
                    + 'This is where marks are strongest: the picture is attached, so "move the car to the kerb" '
                    + 'has something to move and somewhere to move it. Only marks carrying a note apply; read '
                    + 'annotation_list first to see which do.',
            },
        },
        required: ['shot_id'],
    },
    {
        name: 'storyboard_regenerate',
        handler: handleStoryboard, method: 'POST',
        description: 'Generate ONE shot\u2019s keyframe again. Costs credits. Without prompt_override it assembles the prompt itself and trims to fit, which is a safety net rather than a plan. Prefer composing: read shot_prompt, write a prompt that fits the ceiling and says what matters about THIS frame, and send it as prompt_override. Everything listed under references travels as an image, so name those subjects rather than describing them at length — that is where the room goes.',
        path: a => `/film/shots/${a.shot_id}/storyboard/regenerate`,
        body: a => {
            const b = {};
            if (a.prompt_override) b.prompt_override = a.prompt_override;
            if (a.negative_prompt) b.negative_prompt = a.negative_prompt;
            if (a.use_annotations !== undefined) b.use_annotations = a.use_annotations;
            // The schema advertises `use_scene_anchor` and this read `use_anchor`,
            // so setting it did nothing and said nothing. Both are accepted now
            // rather than renaming one: the other spelling is what the route
            // takes, and a tool that silently ignores an argument it documents
            // is worse than one that never offered it.
            const anchorOff = a.use_scene_anchor !== undefined ? a.use_scene_anchor : a.use_anchor;
            if (anchorOff !== undefined) b.use_anchor = anchorOff;
            if (a.direction_mode !== undefined) b.direction_mode = a.direction_mode;
            return b;
        },
        schema: {
            shot_id: { type: 'string' },
            prompt_override: {
                type: 'string',
                description: 'The complete prompt to send, composed by you. Must fit the ceiling from shot_prompt — nothing trims it for you, and a provider truncates the TAIL, which is where the location usually sits.',
            },
            negative_prompt: { type: 'string' },
            direction_mode: {
                type: 'string',
                description: '"action" (default) builds the whole scene from the card, describing every '
                    + 'subject so the model can construct it. "camera" LOCKS the scene to the anchor frame '
                    + '\u2014 same location, same people, same props, same light \u2014 and collapses those '
                    + 'subjects to their names, so the whole prompt is about where the camera stands and what '
                    + 'faces it. Use camera when the scene is right and the ANGLE is wrong; repeated action '
                    + 'regenerations rebuild the subjects from prose each time and drift. Requires an anchor '
                    + 'that CONTAINS what you want kept: an empty establishing wide locks the street and '
                    + 'neither person. Refused with 409 when no anchor is attached.',
            },
            use_scene_anchor: {
                type: 'boolean',
                description: 'Set false to generate this one shot from its plates without putting the '
                    + 'project\u2019s anchor down. Defaults to using the anchor when one is set. Read '
                    + 'shot_prompt to see which frame would be used and why it might not attach.',
            },
            use_annotations: {
                type: 'boolean',
                description: 'Fold the shot\u2019s noted markup into the assembled prompt as a Direction clause, '
                    + 'whatever the project setting. Ignored alongside prompt_override, which is the whole '
                    + 'prompt: read shot_prompt?use_annotations=true, decide what the marks mean, and compose '
                    + 'them in yourself.',
            },
        },
        required: ['shot_id'],
    },
    {
        name: 'consistency_list',
        handler: handleConsistency, method: 'GET',
        description: 'List the consistency profiles for a project, with which are locked. A LOCKED profile is what storyboard and video generation actually condition on; a draft one is exploratory and reaches nothing.',
        path: a => `/film/projects/${a.project_id}/consistency/profiles`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'consistency_create',
        handler: handleConsistency, method: 'POST',
        description: 'Create a consistency profile for a subject, so generation can be told to keep it the same thing in every frame. Generating a plate does NOT create one — a plate is evidence of what a subject looks like and a profile is the commitment to it, and they are separate on purpose. Create it, then lock it with consistency_lock. Idempotent per subject: creating one that already exists returns the existing profile rather than a second.',
        path: a => `/film/projects/${a.project_id}/consistency/profiles`,
        body: a => {
            const { project_id, ...rest } = a || {};
            return rest;
        },
        schema: {
            project_id: { type: 'string' },
            profile_type: { type: 'string', description: 'character, location, prop, style or voice.' },
            subject_id: { type: 'string', description: 'The id of the character, location or prop this is about.' },
            subject_name: { type: 'string', description: 'Its name, as it reads on the board.' },
            canonical_asset_id: { type: 'string', description: 'The plate that defines it, if one has been generated.' },
            notes: { type: 'string' },
        },
        required: ['project_id', 'profile_type'],
    },
    {
        name: 'consistency_delete',
        handler: handleConsistency, method: 'DELETE',
        description: 'Remove a consistency profile. Generation stops conditioning on that subject entirely — the plate stays, but nothing is committed to it any more.',
        path: a => `/film/consistency/profiles/${a.profile_id}`,
        schema: { profile_id: { type: 'string' } }, required: ['profile_id'],
    },
    {
        name: 'consistency_lock',
        handler: handleConsistency, method: 'POST',
        description: 'Lock a consistency profile so generation conditions on it. Lock a subject once you are happy with its plate — that is what keeps it the same object in every frame it appears in.',
        path: a => `/film/consistency/profiles/${a.profile_id}/lock`,
        body: () => ({}),
        schema: { profile_id: { type: 'string' } }, required: ['profile_id'],
    },
    {
        name: 'consistency_unlock',
        handler: handleConsistency, method: 'POST',
        description: 'Return a locked profile to draft, so it can be changed. Generation stops conditioning on it until it is locked again.',
        path: a => `/film/consistency/profiles/${a.profile_id}/unlock`,
        body: () => ({}),
        schema: { profile_id: { type: 'string' } }, required: ['profile_id'],
    },
];

const ROUTE_TOOLS = [
    {
        name: 'flow_list',
        handler: 'listFlows',
        method: 'GET',
        description: 'List the flows a project can use — its own plus every library flow. Start here.',
        path: a => `/film/projects/${a.project_id}/flows`,
        schema: { project_id: { type: 'string' } },
        required: ['project_id'],
        probe: { project_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_get',
        handler: 'getFlow',
        method: 'GET',
        description: 'Read one flow: its nodes, its edges and their typed ports.',
        path: a => `/film/flows/${a.flow_id}`,
        schema: { flow_id: { type: 'string' } },
        required: ['flow_id'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_create',
        handler: 'createFlow',
        method: 'POST',
        description: 'Create a flow from { name, nodes, edges }. Omit project_id in the body to make it a reusable library flow.',
        path: a => `/film/projects/${a.project_id}/flows`,
        schema: {
            project_id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
        },
        required: ['project_id', 'name'],
        bodyKeys: ['name', 'description', 'nodes', 'edges'],
        probe: { project_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_update',
        handler: 'updateFlow',
        method: 'PUT',
        description: 'Replace a flow graph and bump its version. Built-in flows refuse this — duplicate one first.',
        path: a => `/film/flows/${a.flow_id}`,
        schema: {
            flow_id: { type: 'string' },
            name: { type: 'string' },
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
        },
        required: ['flow_id'],
        bodyKeys: ['name', 'description', 'nodes', 'edges'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_delete',
        handler: 'deleteFlow',
        method: 'DELETE',
        description: 'Delete a flow. Built-in flows cannot be deleted.',
        path: a => `/film/flows/${a.flow_id}`,
        schema: { flow_id: { type: 'string' } },
        required: ['flow_id'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_validate',
        handler: 'validateFlow',
        method: 'POST',
        description: 'Check a graph without running it: port compatibility, cycles, orphans. Cheap — run it before flow_run.',
        path: a => `/film/flows/${a.flow_id}/validate`,
        schema: {
            flow_id: { type: 'string' },
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
        },
        required: ['flow_id'],
        bodyKeys: ['nodes', 'edges'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_estimate',
        handler: 'estimateFlow',
        method: 'POST',
        description: 'Projected cost and generation-call count for a run, against the project budget. The budget gate uses this, so check it before flow_run on any fan-out.',
        path: a => `/film/flows/${a.flow_id}/estimate`,
        schema: { flow_id: { type: 'string' }, project_id: { type: 'string' } },
        required: ['flow_id'],
        bodyKeys: ['project_id'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_run',
        handler: 'runFlowRoute',
        method: 'POST',
        description: 'Run a flow to completion and return every node result. GENERATES MEDIA AND SPENDS MONEY. Refused with status 402 when the projected cost would exceed the project budget; pass ignore_budget to override deliberately.',
        path: a => `/film/flows/${a.flow_id}/run`,
        schema: {
            flow_id: { type: 'string' },
            shot_id: { type: 'string' },
            project_id: { type: 'string' },
            vars: { type: 'object' },
            ignore_budget: { type: 'boolean', description: 'Override the budget gate. Say why in your message to the user.' },
        },
        required: ['flow_id'],
        bodyKeys: ['shot_id', 'project_id', 'vars', 'ignore_budget'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_run_get',
        handler: 'getRun',
        method: 'GET',
        description: 'A run with its per-node status, provider routing notes and the graph snapshot it actually ran.',
        path: a => `/film/flow-runs/${a.run_id}`,
        schema: { run_id: { type: 'string' } },
        required: ['run_id'],
        probe: { run_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_run_cancel',
        handler: 'cancelRun',
        method: 'POST',
        description: 'Cancel an in-flight run. Nodes already running finish; nothing new starts.',
        path: a => `/film/flow-runs/${a.run_id}/cancel`,
        schema: { run_id: { type: 'string' } },
        required: ['run_id'],
        probe: { run_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_run_branches',
        handler: 'getBranches',
        method: 'GET',
        description: 'Variants produced by a fan-out, for comparison at a select gate.',
        path: a => `/film/flow-runs/${a.run_id}/branches`,
        schema: { run_id: { type: 'string' } },
        required: ['run_id'],
        probe: { run_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_run_select',
        handler: 'selectBranch',
        method: 'POST',
        description: 'Pick the winning branch at a paused select gate and let the run continue.',
        path: a => `/film/flow-runs/${a.run_id}/select`,
        schema: { run_id: { type: 'string' }, branch: { type: 'string' }, node_id: { type: 'string' } },
        required: ['run_id'],
        bodyKeys: ['branch', 'node_id'],
        probe: { run_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_create_from_template',
        handler: 'createFromTemplate',
        method: 'POST',
        description: 'Instantiate a built-in template into a new editable flow for a project.',
        path: a => `/film/projects/${a.project_id}/flows/from-template`,
        schema: { project_id: { type: 'string' }, template_id: { type: 'string' } },
        required: ['project_id', 'template_id'],
        bodyKeys: ['template_id', 'name'],
        probe: { project_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        // Inline in the router rather than a named handler, hence handler: null.
        name: 'flow_templates',
        handler: null,
        method: 'GET',
        description: 'The ready-made template shelf: multi-model video, character sheet, scene soundscape and the rest.',
        path: () => '/film/flow-templates',
        schema: {},
        required: [],
        probe: {},
    },
    {
        name: 'flow_node_types',
        handler: null,
        method: 'GET',
        description: 'The node palette from the runtime registry: every node type with its typed input and output ports. Read this before authoring a graph.',
        path: () => '/film/flows/node-types',
        schema: {},
        required: [],
        probe: {},
    },
];

function routeToolDefinition(t) {
    return {
        name: t.name,
        description: t.description,
        inputSchema: {
            type: 'object',
            properties: t.schema,
            ...(t.required.length ? { required: t.required } : {}),
        },
        _kind: 'route',
    };
}

async function callRouteTool(t, args) {
    // Production tools build their body from the args they were given, minus
    // the path parameters; flow tools enumerate bodyKeys. Both end up at the
    // same shim so there is still one dispatch path.
    let body;
    if (typeof t.body === 'function') {
        body = t.body(args);
    } else {
        body = {};
        for (const key of t.bodyKeys || []) {
            if (args[key] !== undefined) body[key] = args[key];
        }
    }
    // A tool whose handler depends on its arguments — plate_generate routes to
    // characters or to locations depending on the kind — resolves it here.
    // Without this the dispatcher would send a prop to the character router.
    const handler = typeof t.handlerFor === 'function' ? t.handlerFor(args) : t.handler;
    return callRoute(t.method, t.path(args), body, handler || undefined);
}

// ── Set 4: batch tools ──────────────────────────────────────────────────────
//
// Every MCP tool call is a permission prompt. The fine-grained surface made a
// pre-production pass cost roughly ten of them — list, update, list, update,
// create, create, create, generate — which is an artefact of how the tools were
// cut, not of the work. These collapse the repetitive middle into one call each
// while leaving the two that SPEND MONEY (plate generation, storyboard
// generation) individually gated, because that is where the friction earns its
// keep.
//
// They compose the same route handlers rather than reimplementing anything, so
// scene-card validation, provider resolution and asset registration behave
// exactly as they do over HTTP.

const BATCH_TOOLS = [
    {
        name: 'production_describe',
        description:
            'Describe a whole production in one call: the project look plus every character and location. '
            + 'This is the step that makes frames look like one film — a parsed screenplay leaves appearance_prompt EMPTY, '
            + 'and an undescribed character is redrawn from scratch in every shot. Match by name (case-insensitive) or id.',
        schema: {
            project_id: { type: 'string' },
            style_preset: { type: 'string', description: 'The look applied to every generated frame.' },
            characters: {
                type: 'array',
                description: 'Each { name or id, appearance_prompt, description?, age_range? }.',
                items: { type: 'object' },
            },
            locations: {
                type: 'array',
                description: 'Each { name or id, description, lighting_default? }.',
                items: { type: 'object' },
            },
        },
        required: ['project_id'],
        async run(a) {
            const out = { project_id: a.project_id, style_preset: null, characters: [], locations: [] };

            if (a.style_preset !== undefined) {
                const r = await callRoute('PUT', `/film/projects/${a.project_id}`,
                    { style_preset: a.style_preset }, handleProjects);
                out.style_preset = r._status < 400 ? 'updated' : `failed: ${JSON.stringify(r.body)}`;
            }

            // Resolve names to ids once, so the caller can describe by name.
            const byKind = {
                characters: { list: `/film/projects/${a.project_id}/characters`, key: 'characters', handler: handleCharacters, base: '/film/characters' },
                locations: { list: `/film/projects/${a.project_id}/locations`, key: 'locations', handler: handleLocations, base: '/film/locations' },
            };

            for (const kind of ['characters', 'locations']) {
                const items = Array.isArray(a[kind]) ? a[kind] : [];
                if (!items.length) continue;

                const spec = byKind[kind];
                const listed = await callRoute('GET', spec.list, {}, spec.handler);
                const existing = (listed.body && listed.body[spec.key]) || [];

                for (const item of items) {
                    const match = item.id
                        ? existing.find(e => e.id === item.id)
                        : existing.find(e => String(e.name || '').toUpperCase() === String(item.name || '').toUpperCase());

                    if (!match) {
                        out[kind].push({ name: item.name || item.id, status: 'not found' });
                        continue;
                    }
                    const { id, name, ...fields } = item;
                    const r = await callRoute('PUT', `${spec.base}/${match.id}`, fields, spec.handler);
                    out[kind].push({
                        name: match.name,
                        id: match.id,
                        status: r._status < 400 ? 'updated' : `failed: ${JSON.stringify(r.body)}`,
                    });
                }
            }
            return out;
        },
    },
    {
        name: 'plate_generate',
        description: 'Generate the reference plate for ONE subject. SPENDS CREDITS. Use this rather than plate_generate_all when some subjects already have a plate worth keeping \u2014 generating a plate DELETES the existing one for that subject, so a batch run replaces work you may want to keep. kind is character, location or prop.',
        schema: {
            subject_id: { type: 'string' },
            kind: { type: 'string', description: 'character | location | prop' },
            views: { type: 'array', description: 'Characters only: which of front, side, back. Defaults to all three.' },
        },
        required: ['subject_id', 'kind'],
        /**
         * Routed per kind, because characters live in one handler and locations
         * and props in another.
         *
         * This sat in BATCH_TOOLS carrying `handler`, `path` and `handlerFor` —
         * the shape of a ROUTE tool — and no `run()`. The batch branch of
         * callTool calls `.run(a)` unconditionally, so every invocation died on
         * "run is not a function" before it reached a route. It failed the same
         * way for every subject and every kind, which reads like a data problem
         * and is not: the tool had never been callable at all.
         */
        async run(a) {
            const kind = String(a.kind || 'character');
            const KINDS = {
                character: { handler: handleCharacters, path: id => `/film/characters/${id}/refsheet/generate` },
                location: { handler: handleLocations, path: id => `/film/locations/${id}/plate/generate` },
                prop: { handler: handleLocations, path: id => `/film/props/${id}/plate/generate` },
            };
            const spec = KINDS[kind];
            if (!spec) {
                return { error: `kind must be one of: ${Object.keys(KINDS).join(', ')} (got '${kind}')` };
            }
            return callRoute('POST', spec.path(a.subject_id), a.views ? { views: a.views } : {}, spec.handler);
        },
    },
    {
        name: 'plate_compass',
        description:
            'Photograph all FOUR sides of a location from the one plate it already has: north (the existing plate), '
            + 'east, south and west, each a quarter turn from it. SPENDS CREDITS \u2014 up to three images. '
            + 'Use this when a shot needs the reverse angle: a location with one plate hands every shot the same '
            + 'side of the street, so a shot pointing the other way is given a picture of what is BEHIND its camera '
            + 'and invents the rest. Each side is anchored on the existing plate so the four agree with each other. '
            + 'Refused if the location has no plate yet \u2014 generate one with plate_generate first, because four '
            + 'independently generated views are four different places. A shot then names its side in the scene '
            + "card's location_view.",
        schema: {
            location_id: { type: 'string' },
            overwrite: { type: 'boolean', description: 'Re-shoot sides that already exist. Off by default: a side already photographed is not bought twice.' },
        },
        required: ['location_id'],
        async run(a) {
            return callRoute('POST', `/film/locations/${a.location_id}/plate/compass`,
                a.overwrite ? { overwrite: true } : {}, handleLocations);
        },
    },
    {
        name: 'media_upload',
        description:
            'Add FOOTAGE OR SOUND made outside Film Engine \u2014 a clip cut in Runway or Kling, dialogue '
            + 'recorded properly, a licensed music bed. FREE: nothing is generated. capability is one of '
            + 'video, voice, lipsync, sfx, post (these belong to a SHOT) or music, ambient (these belong '
            + 'to a SCENE) \u2014 call media_kinds to see which, and what each accepts. The file is a '
            + 'base64 data URI; video takes MP4/MOV/WebM/MKV and audio takes WAV/MP3/M4A/FLAC/OGG, '
            + 'decided by the bytes rather than the name. It is stored exactly where a generated file '
            + 'goes with the same asset_type, so the timeline, the conform and the NLE export pick it up '
            + 'unchanged, and it is NOT tracked against the scene card \u2014 editing that card will never '
            + 'say to regenerate over footage that was supplied. Its rights are recorded as unknown. '
            + 'About 112MB maximum.',
        schema: {
            capability: { type: 'string', description: 'video | voice | lipsync | sfx | post | music | ambient' },
            owner_id: { type: 'string', description: 'The shot id, or the scene id for music and ambient.' },
            file: { type: 'string', description: 'data:video/mp4;base64,... or data:audio/wav;base64,...' },
            covers: {
                type: 'array',
                description: 'video only: the OTHER shot ids this one clip also contains, when a single '
                    + 'generation covers several shots (1A-1B-1C). They must be CONSECUTIVE in running '
                    + 'order and in the same project. Those shots then play as part of this clip rather '
                    + 'than holding their own storyboard frames, and stop being reported as missing '
                    + 'footage by the conform and the NLE exports.',
            },
        },
        required: ['capability', 'owner_id', 'file'],
        async run(a) {
            const { MEDIA_KINDS } = require('./media-kinds');
            const spec = MEDIA_KINDS[String(a.capability || '')];
            if (!spec || spec.media === 'image') {
                return {
                    error: `capability must be one of: ${Object.values(MEDIA_KINDS)
                        .filter(k => k.media !== 'image').map(k => k.capability).join(', ')}`,
                };
            }
            const owner = spec.scope === 'scene' ? 'scenes' : 'shots';
            return callRoute('POST', `/film/${owner}/${a.owner_id}/media/${a.capability}/import`,
                { data: a.file, name: a.name, ...(a.covers ? { covers: a.covers } : {}) }, handleMediaImport);
        },
    },
    {
        name: 'media_kinds',
        description:
            'What footage and sound can be uploaded from outside, what formats each accepts, whether it '
            + 'belongs to a shot or a scene, and the size limit. Free. Read this before media_upload: '
            + 'posting a scene-wide music bed at a shot is refused, because attaching a whole scene\u2019s '
            + 'score to one shot would look like it worked.',
        schema: {},
        required: [],
        async run() {
            return callRoute('GET', '/film/media-kinds', {}, handleMediaImport);
        },
    },
    {
        name: 'plate_upload',
        description:
            'Supply a reference picture from OUTSIDE Film Engine instead of generating one \u2014 a '
            + 'photograph of the real location, a Midjourney export, art the department already made. '
            + 'FREE: nothing is generated. kind is character, location, prop or style (style pins it to '
            + 'the mood board). image is a base64 data URI, PNG or JPEG. For a character, view is front, '
            + 'side or back; for a location, view names which side it is (see plate_view_list) and an '
            + 'omitted view is the default plate. It lands exactly where a generated plate lands and '
            + 'REPLACES that view, so every shot referencing the subject uses it immediately. It is '
            + 'deliberately not tracked against the subject\u2019s description: editing that description '
            + 'will not mark an uploaded plate stale, because it was never generated from it. The '
            + "project's style preset is NOT applied to an uploaded picture.",
        schema: {
            kind: { type: 'string', description: 'character | location | prop | style' },
            subject_id: { type: 'string', description: 'The character, location or prop id. For style, the project id.' },
            image: { type: 'string', description: 'data:image/png;base64,... or data:image/jpeg;base64,...' },
            view: { type: 'string', description: 'character: front|side|back. location: which side. Omit for the default plate.' },
            note: { type: 'string', description: 'style only: what this reference is for.' },
        },
        required: ['kind', 'subject_id', 'image'],
        async run(a) {
            const kind = String(a.kind || '').trim();
            const ROUTES = {
                character: { handler: handleCharacters, path: id => `/film/characters/${id}/refsheet/import` },
                location: { handler: handleLocations, path: id => `/film/locations/${id}/plate/import` },
                prop: { handler: handleLocations, path: id => `/film/props/${id}/plate/import` },
                style: { handler: handleMoodBoard, path: id => `/film/projects/${id}/mood-board/import` },
            };
            const spec = ROUTES[kind];
            if (!spec) return { error: `kind must be one of: ${Object.keys(ROUTES).join(', ')} (got '${kind}')` };
            return callRoute('POST', spec.path(a.subject_id), {
                data: a.image, ...(a.view ? { view: a.view } : {}), ...(a.note ? { note: a.note } : {}),
            }, spec.handler);
        },
    },
    {
        name: 'plate_view_list',
        description:
            'The views a location has been photographed from, and whether each picture is really on disk. '
            + 'Free. A location owns a growing set of views and a shot names the one it is pointed at in '
            + "its scene card's location_view; anything else falls back to the original plate, which for a "
            + 'shot looking the other way is a photograph of what is behind its own camera. Read this '
            + 'before plate_view_delete, and before pointing a shot at a side.',
        schema: { location_id: { type: 'string' } },
        required: ['location_id'],
        async run(a) {
            return callRoute('GET', `/film/locations/${a.location_id}/plate/views`, {}, handleLocations);
        },
    },
    {
        name: 'plate_view_delete',
        description:
            "Delete ONE view of a location's plate set. Free. The image is removed and photographing it "
            + 'again costs credits. Use view="__default__" for the original, view-less plate \u2014 which is '
            + 'also the plate the compass sides turn from and the fallback for every shot that names no '
            + 'view, so removing it stops plate_compass working until the location is photographed again. '
            + 'Scene cards naming the deleted view are NOT rewritten: they are reported back, because '
            + 'which side a shot looks at is a decision to be made deliberately. plate_compass skips a '
            + 'side that already exists, so deleting one is how you have it re-shot.',
        schema: {
            location_id: { type: 'string' },
            view: { type: 'string', description: 'The view name, or __default__ for the original plate.' },
        },
        required: ['location_id', 'view'],
        async run(a) {
            return callRoute('DELETE',
                `/film/locations/${a.location_id}/plate/views/${encodeURIComponent(a.view)}`,
                {}, handleLocations);
        },
    },
    {
        name: 'plate_generate_all',
        description:
            'Generate the reference plates every shot will attach: a three-view sheet per character, an establishing plate per location, '
            + 'a product plate per prop. SPENDS CREDITS — roughly 5 per image. Run once after descriptions are written, before storyboards. '
            + 'Reports style_applied per subject: a look can be refused by provider moderation beside a literal subject description.',
        schema: {
            project_id: { type: 'string' },
            kinds: {
                type: 'array',
                description: "Which to generate; defaults to all. Any of 'character', 'location', 'prop'.",
                items: { type: 'string' },
            },
        },
        required: ['project_id'],
        async run(a) {
            const kinds = Array.isArray(a.kinds) && a.kinds.length ? a.kinds : ['character', 'location', 'prop'];
            const out = { project_id: a.project_id, generated: [], failed: [] };

            const sources = [
                { kind: 'character', list: `/film/projects/${a.project_id}/characters`, key: 'characters', handler: handleCharacters, path: id => `/film/characters/${id}/refsheet/generate`, routeHandler: handleCharacters },
                { kind: 'location', list: `/film/projects/${a.project_id}/locations`, key: 'locations', handler: handleLocations, path: id => `/film/locations/${id}/plate/generate`, routeHandler: handleLocations },
                { kind: 'prop', list: `/film/projects/${a.project_id}/props`, key: 'props', handler: handleLocations, path: id => `/film/props/${id}/plate/generate`, routeHandler: handleLocations },
            ].filter(src => kinds.includes(src.kind));

            for (const src of sources) {
                const listed = await callRoute('GET', src.list, {}, src.handler);
                const subjects = (listed.body && listed.body[src.key]) || [];
                for (const subject of subjects) {
                    const r = await callRoute('POST', src.path(subject.id), {}, src.routeHandler);
                    const entry = { kind: src.kind, name: subject.name, id: subject.id };
                    if (r._status < 400) {
                        entry.style_applied = r.body && (r.body.style_applied
                            ?? (Array.isArray(r.body.views) && r.body.views[0] && r.body.views[0].style_applied));
                        out.generated.push(entry);
                    } else {
                        entry.error = (r.body && (r.body.details || r.body.error)) || `HTTP ${r._status}`;
                        out.failed.push(entry);
                    }
                }
            }
            return out;
        },
    },
];

// ── The surface ─────────────────────────────────────────────────────────────

const ALL_ROUTE_TOOLS = [...ROUTE_TOOLS, ...PRODUCTION_TOOLS];

const _tools = [
    ...Object.entries(NODE_TYPES).map(([id, def]) => nodeToolFor(id, def)),
    ...ALL_ROUTE_TOOLS.map(routeToolDefinition),
    ...BATCH_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: t.schema, ...(t.required.length ? { required: t.required } : {}) },
        _kind: 'batch',
    })),
];
const _batchByName = new Map(BATCH_TOOLS.map(t => [t.name, t]));
const _byName = new Map(_tools.map(t => [t.name, t]));
const _routeByName = new Map(ALL_ROUTE_TOOLS.map(t => [t.name, t]));

/** Tool definitions as MCP wants them (internal `_` fields stripped). */
function listTools() {
    return _tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function hasTool(name) {
    return _byName.has(name);
}

/**
 * Run one tool.
 *
 * An unknown name comes back as { unknownTool: true } rather than throwing:
 * the caller has to tell "no such tool" apart from "the tool ran and failed",
 * and MCP reports those differently on the wire.
 */
async function callTool(name, args) {
    const tool = _byName.get(name);
    if (!tool) return { unknownTool: true, error: `unknown tool '${name}'` };

    const a = args || {};
    if (tool._kind === 'batch') {
        try {
            return await _batchByName.get(name).run(a);
        } catch (err) {
            return { error: `${name}: ${err.message}` };
        }
    }
    if (tool._kind === 'route') return callRouteTool(_routeByName.get(name), a);
    return callNodeTool(_nodeTypeByToolName.get(name), a);
}

/**
 * What the model should actually see.
 *
 * Route tools carry an HTTP envelope, which is an artefact of dispatching
 * through handleFlows and means nothing to a caller — unwrapped, `flow_node_types`
 * returns the registry rather than a two-key box containing it. The status is
 * kept only when it explains a refusal: 402 is the budget gate, and a model told
 * merely "failed" would retry the exact call that was too expensive.
 */
function presentResult(result) {
    if (!result || typeof result._status !== 'number') return result;
    if (result._status < 400) return result.body;
    const detail = (result.body && typeof result.body === 'object') ? result.body : { error: result.body };
    return { status: result._status, ...detail };
}

/** Did this result represent a failure the model should see and react to? */
function isFailure(result) {
    if (!result) return true;
    if (result.unknownTool) return true;
    if (typeof result._status === 'number') return result._status >= 400;
    return result.ok === false;
}

module.exports = {
    listTools, hasTool, callTool, isFailure, presentResult,
    toolNameForNodeType, normalizeInputs, callRoute,
    NODE_TOOL_PREFIX, ROUTE_TOOLS, PRODUCTION_TOOLS, BATCH_TOOLS, ALL_ROUTE_TOOLS, SSE_EXCEPTION,
};
