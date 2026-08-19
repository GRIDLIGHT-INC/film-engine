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
const { handleScripts } = require('../routes/scripts');
const { handleScenes } = require('../routes/scenes');
const { handleShots } = require('../routes/shots');
const { handleCharacters } = require('../routes/characters');
const { handleLocations } = require('../routes/locations');
const { handleStoryboard } = require('../routes/storyboard');
const { handleBreakdown } = require('../routes/breakdown');
const { handlePrevis } = require('../routes/previs');
const { handleProductionReports } = require('../routes/production-reports');

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
const PRODUCTION_TOOLS = [
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
        },
        required: ['project_id'],
    },
    {
        name: 'script_get',
        handler: handleScripts, method: 'GET',
        description: 'Read the screenplay. Returns the Fountain source and its parsed elements — read this before writing any shot list.',
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
        description: 'Save blocking for a shot: camera {position,rotation,focalMm,sensorId,fStop}, subject, stage, rig, movement. This is how you try a different angle — set it, preview the frame with previs_to_storyboard, and set it again. Errors block a save; warnings (a slider asked to crane) do not.',
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
        },
        required: ['shot_id'],
    },
    {
        name: 'previs_to_storyboard',
        handler: handlePrevis, method: 'POST',
        description: 'Preview the exact image payload this blocking would generate, WITHOUT generating it or spending anything. Use between angles to see how a framing reads as a prompt before committing a credit to it.',
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
        description: 'Write the staged camera back onto the scene card — shot type, lens, movement, sensor, aperture, height. Only the camera facets the stage determines; description, characters and dialogue survive. Do this when an angle is the one you want to keep.',
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
        name: 'entities_describe',
        handler: handleBreakdown, method: 'POST',
        description: 'Write a visual description for every entity that has none, from the screenplay, using the LLM. Run this after entities_create and BEFORE generating anything: an entity with no description reaches the image prompt as a bare name and every frame then invents its own version of it. Only fills blanks unless force is set. Reports still_blank for anything it could not describe.',
        path: a => `/film/projects/${a.project_id}/entities/describe`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            project_id: { type: 'string' },
            force: { type: 'boolean', description: 'Also rewrite descriptions that already exist. Off by default: a hand-written description is a decision.' },
        },
        required: ['project_id'],
    },
    {
        name: 'character_create',
        handler: handleCharacters, method: 'POST',
        description: 'Create one character. Fill appearance_prompt at the same time: a character row with an empty appearance_prompt reaches the image prompt as a bare name, and every frame then invents its own person.',
        path: a => `/film/projects/${a.project_id}/characters`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            project_id: { type: 'string' },
            name: { type: 'string' },
            appearance_prompt: { type: 'string', description: 'What this person looks like, in prompt terms.' },
            description: { type: 'string' },
            age_range: { type: 'string' },
        },
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
            project_id: { type: 'string' },
            name: { type: 'string' },
            visual_prompt: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string' },
        },
        required: ['project_id', 'name'],
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
    return callRoute(t.method, t.path(args), body, t.handler || undefined);
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
