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
const { handleComments } = require('../routes/scripts');
const { handleMoodBoard } = require('../routes/mood-board');
const { handleAnnotations } = require('../routes/annotations');
const { handleBreakdown } = require('../routes/breakdown');
const { handlePrevis } = require('../routes/previs');
const { handleProductionReports } = require('../routes/production-reports');
const { handleConsistency } = require('../routes/consistency');

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
        description: 'Draw a note on a storyboard frame: arrow, line, rect, ellipse, freehand or text. Geometry is NORMALISED \u2014 points are [[x,y],...] with x and y between 0 and 1 of the frame \u2014 so markup survives the frame being regenerated at another size. Attached to the shot, not the image, so regenerating does not erase the note that asked for it.',
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
        description: 'List the markup notes on a storyboard frame with their ids. Needed before annotation_delete.',
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
            description: { type: 'string', description: 'What is in frame. This is the prompt. Describe the effect, not the object.' },
            action: { type: 'string' },
            camera: { type: 'object', description: '{shot_type, movement, lens} — lens is free text ("40mm anamorphic").' },
            lighting: { type: 'object', description: '{type, notes}' },
            characters: { type: 'array', items: { type: 'string' }, description: 'Everyone in the shot, by name. This is how their appearance reaches the prompt.' },
            props: { type: 'array', items: { type: 'string' }, description: 'Objects in the shot, by name. A prop named here attaches its plate.' },
            dialogue: { type: 'array', items: { type: 'object' } },
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
        name: 'storyboard_regenerate',
        handler: handleStoryboard, method: 'POST',
        description: 'Generate ONE shot\u2019s keyframe again from its current card. Costs credits. Use this after shot_update rather than regenerating the whole board.',
        path: a => `/film/shots/${a.shot_id}/storyboard/regenerate`,
        body: () => ({}),
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'consistency_list',
        handler: handleConsistency, method: 'GET',
        description: 'List the consistency profiles for a project, with which are locked. A LOCKED profile is what storyboard and video generation actually condition on; a draft one is exploratory and reaches nothing.',
        path: a => `/film/projects/${a.project_id}/consistency/profiles`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
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
        handler: handleCharacters, method: 'POST',
        description: 'Generate the reference plate for ONE subject. SPENDS CREDITS. Use this rather than plate_generate_all when some subjects already have a plate worth keeping \u2014 generating a plate DELETES the existing one for that subject, so a batch run replaces work you may want to keep. kind is character, location or prop.',
        path: a => {
            const kind = String(a.kind || 'character');
            if (kind === 'location') return `/film/locations/${a.subject_id}/plate/generate`;
            if (kind === 'prop') return `/film/props/${a.subject_id}/plate/generate`;
            return `/film/characters/${a.subject_id}/refsheet/generate`;
        },
        // Routed per kind, because characters live in one handler and
        // locations and props in another.
        handlerFor: a => (String(a.kind || 'character') === 'character' ? handleCharacters : handleLocations),
        body: a => (a.views ? { views: a.views } : {}),
        schema: {
            subject_id: { type: 'string' },
            kind: { type: 'string', description: 'character | location | prop' },
            views: { type: 'array', description: 'Characters only: which of front, side, back. Defaults to all three.' },
        },
        required: ['subject_id', 'kind'],
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
