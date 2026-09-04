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

const { PROP_CATEGORIES } = require('./prop-categories');
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
const { handleContinuity } = require('../routes/continuity');
const { handleMarketing } = require('../routes/marketing');
const { handleWorlds } = require('../routes/worlds');
const { handleDashboard } = require('../routes/dashboard');
const { handleStoryStructure } = require('../routes/story-structure');
const { handleStoryDevelopment } = require('../routes/story-development');
const { handleSubjectGallery } = require('../routes/subject-gallery');
const { handleMusicGen } = require('../routes/music-gen');
const { handleVoiceCasting } = require('../routes/voice-casting');
const { handleScripts } = require('../routes/scripts');
const { handleScenes } = require('../routes/scenes');
const { handleShots } = require('../routes/shots');
const { handleCharacters } = require('../routes/characters');
const { handleGenerationJobs } = require('../routes/generation-jobs');
const { handleLocations } = require('../routes/locations');
const { handleStoryboard } = require('../routes/storyboard');
const { handleComments } = require('../routes/scripts');
const { handleMoodBoard } = require('../routes/mood-board');
const { handleStyleBook } = require('../routes/style-book');
const { handleAssets } = require('../routes/assets');
const { handleMediaImport } = require('../routes/media-import');
const { handleVideoGen } = require('../routes/video-gen');
const { handleSequences } = require('../routes/sequences');
const { handleAnnotations } = require('../routes/annotations');
const { handleBreakdown } = require('../routes/breakdown');
const { handlePrevis } = require('../routes/previs');
const { handleThreeD } = require('../routes/threed');
const { handleProductionReports } = require('../routes/production-reports');
const { handleNLEExport } = require('../routes/nle-export');
const { handleDeliverables } = require('../routes/deliverables');
const { handleBrands } = require('../routes/brands');
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

/**
 * Where to go instead, for the nodes that have a purpose-built route.
 *
 * `gen.music` derives its own prompt from the scene and never reads the cue
 * somebody wrote, so reaching for it to generate a written score produces a
 * scene-derived bed. That happened, and the reason it happened is that it was
 * the ONLY generation surface exposed for music.
 */
const SPENDING_NODE_ALTERNATIVE = Object.freeze({
    'gen.music': 'Derives its prompt from the SCENE and ignores any written cue — to generate a '
        + 'cue you authored, use `music_cue_generate`, which reads the cue, persists the asset '
        + 'and links it back.',
});

function describeNodeTool(id, def) {
    const bits = [`Run the \`${id}\` node — ${def.label}.`, `Kind: ${def.kind}.`];
    if (def.capability) {
        bits.push(`Calls the '${def.capability}' capability, so it resolves a provider and may cost money.`);
        /*
         * A node run ALONE stores nothing, and that is easy to be wrong about.
         *
         * Inside a graph, persistence is `out.asset`'s job -- deliberately, so
         * a handler is not also a storage layer. Executed on its own through
         * MCP there is no `out.asset` downstream, so the bytes come back in the
         * tool result and reach film_assets never: a paid generation that
         * exists only in a transcript. Said here because the description is the
         * only place an agent can learn it, and it was learned the expensive
         * way -- an MP3 that had to be pulled out of raw tool output by hand.
         */
        bits.push('NOT SAVED: run alone this returns the media in the tool result and writes NO '
            + 'asset row — inside a flow, `out.asset` is what persists it.');
        if (SPENDING_NODE_ALTERNATIVE[id]) bits.push(SPENDING_NODE_ALTERNATIVE[id]);
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
    /*
     * WORLD ENGINE. A world is the persistent SET many shots are framed inside
     * — not a shot, and not a subject. Everything here is free except
     * `world_generate`, which is the only tool in this group that resolves a
     * provider and bills.
     */
    {
        name: 'world_create',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/projects/${a.project_id}/worlds`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        description:
            'Create a spatial world — a persistent set that many shots can be framed inside. FREE: '
            + 'this makes the record, it does not reconstruct anything. Generating is a separate, '
            + 'paid step. A world usually corresponds to a LOCATION, so pass location_id where one '
            + 'exists; that is what lets its compass plates become the reconstruction input.',
        schema: {
            project_id: { type: 'string' }, name: { type: 'string' },
            description: { type: 'string' }, scene_id: { type: 'string' }, location_id: { type: 'string' },
        }, required: ['project_id', 'name'],
    },
    {
        name: 'world_list',
        handler: handleWorlds, method: 'GET',
        path: a => `/film/projects/${a.project_id}/worlds`,
        description: 'Every world in a project, each with its versions. FREE.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'world_get',
        handler: handleWorlds, method: 'GET',
        path: a => `/film/worlds/${a.world_id}`,
        description:
            'One world: its versions, which is active, and whether it is locked. FREE. Each version '
            + 'reports scale_state — APPROXIMATE SCALE until somebody calibrates it, because Marble '
            + 'promises no unit and an unmeasured world has no metres to give you.',
        schema: { world_id: { type: 'string' } }, required: ['world_id'],
    },
    {
        name: 'world_plan',
        handler: handleWorlds, method: 'GET',
        path: a => `/film/world-versions/${a.world_version_id}/plan${a.model ? `?model=${encodeURIComponent(a.model)}` : ''}`,
        description:
            'What generating this world version would cost, in credits. FREE, and priced through the '
            + 'same rate table the run bills from — so the number here is the number charged. Read '
            + 'this before world_generate.',
        schema: { world_version_id: { type: 'string' }, model: { type: 'string' } },
        required: ['world_version_id'],
    },
    {
        name: 'world_generate',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/world-versions/${a.world_version_id}/generate`,
        body: a => { const { world_version_id, ...rest } = a || {}; return rest; },
        description:
            'Reconstruct a world. SPENDS MONEY — 250 credits on the draft model, up to 3100 on the '
            + 'largest. Call world_plan first. `images` are the location plates: several views of one '
            + 'place reconstruct far better than one, and up to four are used with their compass '
            + 'bearing. If the call is abandoned mid-generation the result is reported as pending '
            + 'with an operation id rather than failed — the world is collectable, not lost.',
        schema: {
            world_version_id: { type: 'string' }, prompt: { type: 'string' },
            images: { type: 'array', description: 'Plates: [{ data (base64) or uri, extension, view }]' },
            video: { type: 'object', description: 'A walkthrough: { data or uri, extension }' },
            include_splats: { type: 'boolean', description: 'Also download the Gaussian splats (25 MB at full res). Off by default.' },
        }, required: ['world_version_id'],
    },
    {
        name: 'world_calibrate',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/world-versions/${a.world_version_id}/calibrate`,
        body: a => { const { world_version_id, ...rest } = a || {}; return rest; },
        description:
            'Give a world a scale, by naming one thing inside it whose real size is known. FREE. '
            + 'Until this is done every distance and focal length computed in the world is '
            + 'meaningless, because Marble reconstructs geometry without a unit. Both operands are '
            + 'stored beside the factor so the calibration can be re-derived and argued with.',
        schema: {
            world_version_id: { type: 'string' },
            source: { type: 'string', description: 'character_height | door_height | car_length | distance | custom' },
            known_meters: { type: 'number' },
            measured_units: { type: 'number', description: 'How many world units that thing spans.' },
        }, required: ['world_version_id', 'source', 'known_meters', 'measured_units'],
    },
    {
        name: 'world_lock',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/worlds/${a.world_id}/lock`,
        description:
            'Lock a world so it cannot be regenerated or rescaled. FREE. Blocking shots, pinning them '
            + 'and rendering plates all still work — a lock that froze the work would be one nobody '
            + 'switches on. Unlock with world_unlock.',
        schema: { world_id: { type: 'string' } }, required: ['world_id'],
    },
    {
        name: 'world_unlock',
        handler: handleWorlds, method: 'DELETE',
        path: a => `/film/worlds/${a.world_id}/lock`,
        description: 'Unlock a world so it can be regenerated or rescaled again. FREE.',
        schema: { world_id: { type: 'string' } }, required: ['world_id'],
    },
    /*
     * DIRECT THE SHOT — a brief/propose pair, never a server-side model.
     *
     * The connected model IS the model here. `cinematography_brief` hands over
     * the geometry and returns no answer; the model reasons; `camera_propose`
     * takes the camera back and refuses what the world will not accept. All
     * three are FREE — nothing here generates an image.
     */
    {
        name: 'cinematography_brief',
        handler: handleWorlds, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/direct${a.intent ? `?intent=${encodeURIComponent(a.intent)}` : ''}`,
        description:
            'Everything needed to judge a shot: the camera as it stands, where each subject is and '
            + 'which way they read in frame, the world bounds and whether it has a real scale, the '
            + '180-degree axis and which side the scene was established on. FREE. It returns FACTS '
            + 'AND NO CONCLUSION — no camera is proposed here, because deciding what the shot should '
            + 'be is what you are being asked for. Pass an `intent` (heroic, vulnerable, oppressive, '
            + 'intimate, chaotic, isolated, cinematic_depth) and it also returns what that intention '
            + 'tends to mean cinematographically, as a bias to reason with rather than a formula.',
        schema: {
            shot_id: { type: 'string' },
            intent: { type: 'string', description: 'One of the seven director intentions. Optional.' },
        }, required: ['shot_id'],
    },
    {
        name: 'camera_propose',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/direct`,
        body: a => { const { shot_id, ...rest } = a || {}; return rest; },
        description:
            'Hand back the camera you decided on. FREE. The engine validates it against the world '
            + 'and REFUSES one that cannot be shot — inside geometry, subject behind the lens, '
            + 'clipping, an impossible focus, or occluded — naming the check that caught it so you '
            + 'can correct it. Crossing the 180-degree line is reported as a warning and allowed, '
            + 'because it is a real creative choice. You may change the CAMERA only: lens, height, '
            + 'dolly/truck/pedestal, pan/tilt/roll, framing target, occupancy target, rig. Changing '
            + 'the world, the blocking, who is in the shot or the look is refused by name. '
            + 'Nothing is written unless you pass apply: true.',
        schema: {
            shot_id: { type: 'string' },
            rationale: { type: 'string', description: 'Why this camera. Required — a change nobody can argue with is one nobody can learn from.' },
            changes: { type: 'object', description: 'focalLengthMm, cameraHeightM, dollyM, truckM, pedestalM, panDeg, tiltDeg, rollDeg, targetOccupancy, framingTarget, rig' },
            apply: { type: 'boolean', description: 'Write it onto the shot. Default false — propose first, look, then apply.' },
            strict: { type: 'boolean', description: 'Refuse a line crossing as well, for a sequence where continuity is the point.' },
        }, required: ['shot_id', 'rationale', 'changes'],
    },
    {
        name: 'camera_explore_brief',
        handler: handleWorlds, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/direct/explore`,
        description:
            'The same facts, plus the six coverage categories to propose against: Neutral Wide, '
            + 'Heroic Low, Long Lens Compression, Extreme Foreground, Over the Shoulder, and '
            + 'Dutch / Unstable. FREE, and again no cameras are proposed. Send your six back to '
            + 'camera_explore_accept, which drops any that cannot be shot and says why rather than '
            + 'padding the set — a coverage grid containing an impossible camera is worse than a '
            + 'short one.',
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
    },
    {
        name: 'camera_explore_accept',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/direct/explore`,
        body: a => ({ candidates: a.candidates }),
        description:
            'Validate the six cameras you proposed against the world. FREE. Returns the ones that '
            + 'can be shot, the ones that cannot with the check that caught each, and how far short '
            + 'of six the usable set falls.',
        schema: {
            shot_id: { type: 'string' },
            candidates: { type: 'array', description: 'One per category: [{ key, rationale, changes }]' },
        }, required: ['shot_id', 'candidates'],
    },
    {
        name: 'world_delete',
        handler: handleWorlds, method: 'DELETE',
        path: a => `/film/worlds/${a.world_id}`,
        description:
            'Delete a world and every version, asset and source under it. FREE. Blocking authored '
            + 'inside it is KEPT — deleting a set must not take the camera work a director staged in '
            + 'it; the shots simply lose their world pin. The generated worlds themselves cost money '
            + 'and cannot be re-fetched from the provider, so this is not reversible.',
        schema: { world_id: { type: 'string' } }, required: ['world_id'],
    },
    {
        name: 'world_pin_shot',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/world`,
        body: a => ({ world_version_id: a.world_version_id }),
        description:
            'Pin a shot to one version of a world, so it is always framed inside the geometry it was '
            + 'approved against. FREE. A newer version never migrates a pinned shot automatically — '
            + 'the pin reports that a newer one exists and leaves the decision to the director.',
        schema: { shot_id: { type: 'string' }, world_version_id: { type: 'string' } },
        required: ['shot_id', 'world_version_id'],
    },
    {
        name: 'milestone_list',
        handler: handleDashboard, method: 'GET',
        path: a => `/film/projects/${a.project_id}/milestones`,
        description:
            'The production timeline for a project: every milestone with its phase, status and '
            + 'completion. FREE. A project with none gets the nine standard phases seeded on first '
            + 'read, so this is also how a timeline comes into existence.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'milestone_update',
        handler: handleDashboard, method: 'PUT',
        path: a => `/film/projects/${a.project_id}/milestones/${a.milestone_id}`,
        body: a => { const { project_id, milestone_id, ...rest } = a || {}; return rest; },
        description:
            'Move one milestone: its status, completion percentage, dates or title. `status` is '
            + 'pending, in_progress, completed or skipped; `completion_pct` is 0-100 and is clamped. '
            + 'Setting a milestone complete does NOT set the ones before it — a timeline where the '
            + 'last box is ticked and the middle ones are not is a real state worth being able to '
            + 'express, and guessing otherwise would rewrite history the director did not.',
        schema: {
            project_id: { type: 'string' },
            milestone_id: { type: 'string', description: 'From milestone_list.' },
            status: { type: 'string', description: 'pending | in_progress | completed | skipped' },
            completion_pct: { type: 'number', description: '0-100.' },
            actual_date: { type: 'string', description: 'When it actually landed, ISO date.' },
            target_date: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            phase: { type: 'string' },
        },
        required: ['project_id', 'milestone_id'],
    },
    {
        name: 'agent_presence',
        handler: require('../routes/agent-presence').handleAgentPresence, method: 'GET',
        path: () => '/film/agent',
        description:
            'What this engine knows about the agent host attached to it, and what that host can '
            + 'DO. FREE. `can_ask_the_host` is the one to read: MCP runs one direction — a host '
            + 'calls this server and this server cannot call back — so whether Film Engine can ask '
            + 'the model you are already talking to, instead of spending the project\u2019s API key on a '
            + 'server-side one, depends on the host declaring the `sampling` capability at '
            + 'initialize. Reported from the live connection rather than from documentation about '
            + 'somebody else\u2019s build.',
        schema: {}, required: [],
    },
    {
        name: 'generation_pending',
        handler: handleGenerationJobs, method: 'GET',
        path: a => `/film/projects/${a.project_id}/generation-jobs`,
        description:
            'What this project has generations OUTSTANDING for \u2014 accepted by their provider and '
            + 'not yet delivered here. FREE. A tool call is abandoned by the agent host at 60 seconds, '
            + 'and a video or a 4K mesh routinely takes longer, so a generation that "failed to respond" '
            + 'is usually still running and already paid for. Check here before generating the same '
            + 'thing again, which would buy it twice.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'generation_collect',
        handler: handleGenerationJobs, method: 'POST',
        path: a => `/film/generation-jobs/${a.job_id}/collect`,
        // Same defect `spend_record` was caught by: a POST tool declaring
        // neither `body` nor `bodyKeys` posts `{}`, so `belongs_to` never
        // reached the route and the one handle it exists for could not be
        // filed as the leg it was bought for.
        body: a => ((a && a.belongs_to) ? { belongs_to: a.belongs_to } : {}),
        description:
            'Deliver a generation that was accepted earlier, from its handle. FREE \u2014 this polls a '
            + 'job already paid for and never starts a new one. Safe to call repeatedly: a job still '
            + 'running answers "not finished yet" and stays collectable. Use it after a generation tool '
            + 'reports that the host abandoned the call, and after `generation_pending` lists a job. '
            + 'Also re-polls a job this engine recorded as FAILED: a failure on this side does not '
            + 'un-render or refund anything, and the provider is the authority on its own job.',
        schema: {
            job_id: { type: 'string' },
            belongs_to: {
                type: 'object',
                description: 'Names what a generation was FOR when the handle does not say. For a PLATE: { kind: character|location|prop, subject_id, view? } \u2014 this also claims a job already settled, filing the picture it left on disk under a job id, with nothing re-polled and nothing re-bought. Otherwise: only for a handle recorded before the engine stamped what it was. '
                    + 'For a sequence leg: { sequence_id, from, to, from_shot_id }. Without it an '
                    + 'older clip is stored but not filed as the leg it was bought for.',
            },
        }, required: ['job_id'],
    },
    {
        name: 'orientation_plan_brief',
        handler: handleLocations, method: 'GET',
        path: a => `/film/locations/${a.location_id}`,
        description: 'Read the free location brief used to author an orientation plan: structured set description, existing compass edges, scenes and linked props. No server-side model is called.',
        schema: { location_id: { type: 'string' } }, required: ['location_id'],
    },
    {
        name: 'orientation_plan_update',
        handler: handleLocations, method: 'PUT',
        path: a => `/film/locations/${a.location_id}`,
        body: a => ({ orientation_plan: a.orientation_plan }),
        description: 'Write the compass plan the connected LLM authored. Keeps structured geography beside any uploaded plan image.',
        schema: {
            location_id: { type: 'string' },
            orientation_plan: { type: 'object', description: '{ north, east, south, west, interior: [exactly three room zones], marker }' },
        },
        required: ['location_id', 'orientation_plan'],
    },
    {
        name: 'orientation_plan_upload',
        handler: handleLocations, method: 'POST',
        path: a => `/film/locations/${a.location_id}/orientation-plan/import`,
        body: a => ({ data: a.image, name: a.name || 'orientation-plan' }),
        description: 'Upload the orientation-plan image generated by the connected model. FREE: Film Engine stores the supplied PNG/JPEG and calls no image provider.',
        schema: {
            location_id: { type: 'string' },
            image: { type: 'string', description: 'data:image/png;base64,... or data:image/jpeg;base64,...' },
            name: { type: 'string' },
        },
        required: ['location_id', 'image'],
    },
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
        name: 'dry_run',
        handler: handleDashboard, method: 'GET',
        path: a => `/film/projects/${a.project_id}/dry-run`
            + (a.shot_id ? `?shot_id=${encodeURIComponent(a.shot_id)}` : ''),
        description: 'FREE and sends NOTHING. For every capability this production uses, reports the '
            + 'provider and model that would run, what the request is composed FROM (scene card, '
            + 'style preset, plates, keyframe, blocking), the exact body the provider would '
            + 'receive, and what the rate book says it costs. Built from the same construction path '
            + 'the real generations use and from each adapter\u2019s own request builder, so it '
            + 'cannot drift from what is actually sent. Credentials never appear and pictures are '
            + 'described rather than printed. Use it to answer "what will this cost and what will '
            + 'it be asked for" before spending anything.',
        schema: {
            project_id: { type: 'string' },
            shot_id: { type: 'string', description: 'Describe from this shot. Omitted, the most '
                + 'built-up shot is used, so the report shows a real request rather than an empty one.' },
        },
        required: ['project_id'],
    },
    {
        name: 'marketing_list',
        handler: handleMarketing, method: 'GET',
        path: a => `/film/projects/${a.project_id}/marketing`
            + (a.type ? `?type=${encodeURIComponent(a.type)}` : ''),
        description: 'Posters, key art, banners and social cards for a project. FREE.',
        schema: { project_id: { type: 'string' }, type: { type: 'string', description: 'Filter: poster | key_art | banner | social_card | still | thumbnail | logo' } },
        required: ['project_id'],
    },
    {
        name: 'marketing_create',
        handler: handleMarketing, method: 'POST',
        path: a => `/film/projects/${a.project_id}/marketing`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        description: 'Plan a marketing asset. FREE \u2014 this creates the record, it does not make '
            + 'the artwork. `prompt` LEADS the image request and should describe the SUBJECT; the '
            + "film's style preset is appended after it, so do not restate the look.",
        schema: {
            project_id: { type: 'string' },
            type: { type: 'string', description: 'poster | key_art | banner | social_card | still | thumbnail | logo' },
            title: { type: 'string' },
            prompt: { type: 'string', description: 'What the artwork shows. Subject, not look.' },
            aspect_ratio: { type: 'string', description: 'e.g. "2:3" for a one-sheet, "16:9" for a banner.' },
            resolution: { type: 'string', description: 'e.g. "1080x1620".' },
        },
        required: ['project_id', 'type', 'title'],
    },
    {
        name: 'marketing_generate',
        handler: handleMarketing, method: 'POST',
        path: a => `/film/marketing/${a.marketing_id}/generate`,
        body: a => ({ ...(a.quality ? { quality: a.quality } : {}) }),
        description: 'COSTS CREDITS. Generate the artwork for a marketing asset. Call '
            + 'marketing_preview first \u2014 it is free and shows exactly what would be sent, '
            + "including whether the film's style preset is applied. Replaces any existing artwork "
            + 'on this asset. quality picks the image tier for this one generation: draft, standard '
            + 'or precision.',
        schema: {
            marketing_id: { type: 'string' },
            quality: { type: 'string', description: 'draft | standard | precision' },
        },
        required: ['marketing_id'],
    },
    {
        name: 'marketing_delete',
        handler: handleMarketing, method: 'DELETE',
        path: a => `/film/marketing/${a.marketing_id}`,
        description: 'Remove a marketing asset. The artwork file stays on disk \u2014 it cost money '
            + 'to make, so deleting the plan must not delete the picture.',
        schema: { marketing_id: { type: 'string' } },
        required: ['marketing_id'],
    },
    {
        name: 'marketing_upload',
        handler: handleMarketing, method: 'POST',
        path: a => `/film/marketing/${a.marketing_id}/import`,
        body: a => ({ data: a.image, name: a.name }),
        description: 'Put artwork you made yourself onto a marketing asset. FREE \u2014 nothing is '
            + 'generated and no image provider is called, so this is how to deliver a poster without '
            + 'spending image credits. image is a PNG or JPEG data URI. It replaces whatever that '
            + 'asset was showing.',
        schema: {
            marketing_id: { type: 'string' },
            image: { type: 'string', description: 'data:image/png;base64,... or data:image/jpeg;base64,...' },
            name: { type: 'string' },
        },
        required: ['marketing_id', 'image'],
    },
    {
        name: 'marketing_preview',
        handler: handleMarketing, method: 'GET',
        path: a => `/film/marketing/${a.marketing_id}/preview`,
        description: 'What generating this artwork would send, and on which provider. FREE \u2014 '
            + 'nothing is generated and nothing is spent. Says whether the film\u2019s style preset '
            + 'is applied: without one the art will not match the film.',
        schema: { marketing_id: { type: 'string' } },
        required: ['marketing_id'],
    },
    {
        name: 'continuity_upload',
        handler: handleContinuity, method: 'POST',
        path: a => `/film/continuity/${a.ref_id}/import`,
        body: a => ({ data: a.image, name: a.name }),
        description:
            'Attach a picture to a continuity reference. FREE \u2014 nothing is generated. A '
            + 'continuity reference records what a thing ACTUALLY looked like when it was shot, so '
            + 'the picture is normally a photograph or a frame you already have rather than '
            + 'something made for the purpose. image is a PNG or JPEG data URI. It replaces '
            + 'whatever that reference was showing. Note this is a record for people to compare '
            + 'against \u2014 it is NOT a generation reference, and no prompt reads it; use '
            + 'plate_upload if you want a picture that conditions future frames.',
        schema: {
            ref_id: { type: 'string', description: 'The continuity reference id (see continuity board).' },
            image: { type: 'string', description: 'data:image/png;base64,... or data:image/jpeg;base64,...' },
            name: { type: 'string', description: 'Optional filename; the reference title is used otherwise.' },
        },
        required: ['ref_id', 'image'],
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
        name: 'refsheet_orbit_preview',
        handler: handleCharacters, method: 'GET',
        description: 'What an orbit turnaround would cost and produce, for FREE. A character sheet '
            + 'made from ONE clip that orbits the character, cut into front / three-quarter / side / '
            + 'back — frames of one continuous motion cannot disagree with each other, which three '
            + 'separately generated plates can and have. Reports the credit estimate, the frames it '
            + 'would cut, and whether an approved front plate exists to seed it. SPENDS NOTHING.',
        path: a => `/film/characters/${a.character_id}/refsheet/orbit/preview`
            + (a.seconds ? `?seconds=${encodeURIComponent(a.seconds)}` : ''),
        schema: {
            character_id: { type: 'string' },
            seconds: { type: 'number', description: 'Clip length; 5 is the default and costs 25 credits.' },
        },
        required: ['character_id'],
    },
    {
        name: 'refsheet_orbit',
        handler: handleCharacters, method: 'POST',
        description: 'Generate a character turnaround from ONE orbiting clip and cut it into views. '
            + 'SPENDS CREDITS — about 25 for a 5-second orbit, against roughly 45 for three separate '
            + 'plates, and the views are consistent because they are frames of the same motion. '
            + 'Seeded from the approved front plate when one exists; without it the orbit invents a '
            + 'new person, so generate the front plate first. Read refsheet_orbit_preview before this.',
        path: a => `/film/characters/${a.character_id}/refsheet/orbit`,
        body: a => ({ seconds: a.seconds, model: a.model }),
        schema: {
            character_id: { type: 'string' },
            seconds: { type: 'number', description: 'Clip length in seconds; 5 by default.' },
            model: { type: 'string', description: 'Video model; gen4_turbo by default (5 credits/second).' },
        },
        required: ['character_id'],
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
        path: a => `/film/shots/${a.shot_id}/video/preview`
            + (a.tier ? `?tier=${encodeURIComponent(a.tier)}` : ''),
        description: 'What a clip for this shot would be asked for, and what it would COST \u2014 free, and nothing is generated. Reports the model, the length, whether the storyboard frame is attached, the reference package the model would receive, and an itemised credit estimate including reference charges and any minimum. Pass `tier` (draft | production | hero) to price the tier you are considering: a draft is 25 credits for five seconds, the cheap way to check blocking before buying the real shot. SPENDS NOTHING.',
        schema: { shot_id: { type: 'string' },
            tier: { type: 'string', enum: ['draft', 'production', 'hero'], description: 'Price and plan this tier. draft = Gen-4 Turbo, 5s, 25 credits — the blocking check. production = H3 768P with the reference package. hero = your choice.' } },
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
        name: 'sequence_plan_inbetweens',
        handler: handleSequences, method: 'GET',
        path: a => `/film/sequences/${a.sequence_id}/plan?expand=inbetweens`
            + (a.cadence_s ? `&cadence_s=${a.cadence_s}` : '')
            + (a.shape ? `&shape=${a.shape}` : ''),
        description:
            'The sequence as a STRIP OF STATIONS \u2014 a frame per second of film, derived from each '
            + 'shot\u2019s own camera blocking. FREE, and read it before spending: a five-second push-in '
            + 'otherwise reaches the provider as ONE picture and a sentence, so seconds two, three and '
            + 'four are the model\u2019s opinion, and the model\u2019s opinion is what drifts. '
            + 'Reports `strips` (per shot: how many stations, how many need generating, whether the '
            + 'strip was thinned to fit the model\u2019s image ceiling and what it wanted), '
            + '`images_needed` and `images_estimated_credits`. A shot whose move will not READ '
            + 'contributes exactly one station and costs nothing. The station cap comes from the '
            + 'model\u2019s own contract \u2014 Seedance 2.5 documents 30 free images, Hailuo 3 takes 9 '
            + 'at 2 credits each. `shape=legs` (default) plans N-1 short generations to stitch; '
            + '`shape=bundle` sends the strip as references in one longer generation, Seedance only.',
        schema: {
            sequence_id: { type: 'string' },
            cadence_s: { type: 'number', description: 'Seconds between stations. Default 1.' },
            shape: { type: 'string', enum: ['legs', 'bundle'] },
        },
        required: ['sequence_id'],
    },
    {
        name: 'sequence_inbetweens',
        handler: handleSequences, method: 'POST',
        path: a => `/film/sequences/${a.sequence_id}/inbetweens`,
        body: a => ({ cadence_s: a.cadence_s }),
        description:
            'GENERATE the strip. COSTS CREDITS \u2014 one image per station after the first. Each station '
            + 'is refined FROM THE ONE BEFORE IT, which is the whole source of continuity: generating '
            + 'each independently from the shot\u2019s keyframe would be N rolls of the dice and would '
            + 'reinvent the drift a strip exists to remove. Serial by construction, and it stops at the '
            + 'first provider refusal and NAMES what it did not attempt rather than buying the same '
            + 'failure N times. Station 0 is never generated \u2014 it is the frame you approved, and a '
            + 'frame made from itself can only reproduce itself. Re-running skips stations that already '
            + 'exist. Read sequence_plan_inbetweens first: it is free and reports the cost.',
        schema: {
            sequence_id: { type: 'string' },
            cadence_s: { type: 'number', description: 'Seconds between stations. Default 1.' },
        },
        required: ['sequence_id'],
    },
    {
        name: 'sequence_station_update',
        handler: handleSequences, method: 'PUT',
        path: a => `/film/sequences/${a.sequence_id}/stations/${a.shot_id}/${a.station_index}`,
        body: a => ({ instruction: a.instruction }),
        description:
            'Redo one station and EVERYTHING AFTER IT. COSTS CREDITS. A chain re-inherits from the frame '
            + 'that changed, so leaving the later stations would leave a strip whose second half '
            + 'descends from a picture that no longer exists. Stations before the one named are '
            + 'untouched. Station 0 is refused: it is the approved keyframe, not a station.',
        schema: {
            sequence_id: { type: 'string' }, shot_id: { type: 'string' },
            station_index: { type: 'number', description: '1 or higher. 0 is the approved frame.' },
            instruction: { type: 'string', description: 'What this station does differently from the one before it.' },
        },
        required: ['sequence_id', 'shot_id', 'station_index'],
    },
    {
        name: 'sequence_station_list',
        handler: handleSequences, method: 'GET',
        path: a => `/film/sequences/${a.sequence_id}/stations`
            + (a.cadence_s ? `?cadence_s=${a.cadence_s}` : ''),
        description:
            'The strip as it stands: every station of every shot, with the moment it sits at, the '
            + 'instruction that separates it from the one before, and whether it has been generated. '
            + 'FREE. Read this before correcting or deleting a station \u2014 an agent that can remove '
            + 'one and cannot list them is one that deletes by guessing. Also reports the strip '
            + 'fingerprint and whether it is still the one that was approved.',
        schema: {
            sequence_id: { type: 'string' },
            cadence_s: { type: 'number', description: 'Seconds between stations. Default 1.' },
        },
        required: ['sequence_id'],
    },
    {
        name: 'sequence_station_delete',
        handler: handleSequences, method: 'DELETE',
        path: a => `/film/sequences/${a.sequence_id}/stations/${a.shot_id}/${a.station_index}`,
        description:
            'Drop one station. Its neighbours become adjacent, so the strip is one segment shorter. '
            + 'Any approval is CLEARED, because it described a strip that no longer exists.',
        schema: {
            sequence_id: { type: 'string' }, shot_id: { type: 'string' },
            station_index: { type: 'number' },
        },
        required: ['sequence_id', 'shot_id', 'station_index'],
    },
    {
        name: 'sequence_inbetweens_approve',
        handler: handleSequences, method: 'POST',
        path: a => `/film/sequences/${a.sequence_id}/inbetweens/approve`,
        description:
            'Sign off the strip. FREE. Fingerprints the ordered stations and their instructions, and '
            + 'video generation on this sequence then REFUSES 409 STALE_APPROVAL if the strip has '
            + 'changed since \u2014 the same contract previs_approve carries, and the reason a director '
            + 'can trust that the strip that shot is the strip they signed off. Refuses a strip with '
            + 'ungenerated stations: approving pictures nobody has seen is not an approval. '
            + '`ignore_approval` on sequence_generate is the deliberate way past.',
        schema: { sequence_id: { type: 'string' } }, required: ['sequence_id'],
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
            target_resolution: {
                type: 'string',
                description: 'Delivery raster, "WIDTHxHEIGHT" — e.g. "1920x1080", "2560x1440", '
                    + '"3840x2160". This is what every video generation resolves its tier from. A '
                    + 'provider serves the nearest tier AT OR BELOW the ask and never above it, so a '
                    + 'raster it has no tier for (2560x1440 on Seedance) renders one step down — '
                    + 'sequence_plan says so before anything is bought.',
            },
            video_draft: {
                type: 'boolean',
                description: 'Generate footage at the model\'s cheapest documented tier instead of '
                    + 'the delivery raster. ON by default and worth leaving on while blocking: on '
                    + 'Seedance a draft second is $0.17 against $0.85 at 1080p. Turn it OFF for the '
                    + 'take you intend to keep. Video only — the board is unaffected.',
            },
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
        description: 'Update a project. Use style_preset to set the look for every generated frame, '
            + 'and aspect_ratio to set the delivery frame (e.g. "2.39:1"). target_resolution and '
            + 'video_draft together decide what every second of footage COSTS — read sequence_plan '
            + 'after changing either; it is free and quotes the tier and the dollars.',
        path: a => `/film/projects/${a.project_id}`,
        body: a => {
            const { project_id, ...rest } = a || {};
            return rest;
        },
        schema: {
            client: { type: 'string', description: 'Commercial mode: who the spot is for. Groups spend by client in spend_report.' },
            campaign: { type: 'string', description: 'Commercial mode: which campaign this spot belongs to.' },
            brand_id: { type: 'string', description: 'A film_brands row. The kit outlives the project; \'\' unlinks.' },
            target_duration_ms: { type: 'number', description: 'The runtime this spot is BOUGHT at, exactly. A conform that misses it by more than a frame REFUSES rather than trimming. 0 means no target, which is every film.' },
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
            provider_config: {
                type: 'object',
                description: 'Which generator this project uses, per capability — '
                    + '{"image":"meshy","video":"runway"}. MERGED, never replaced: keys you omit keep '
                    + 'their stored value, so configuring one capability cannot drop the others. Send '
                    + 'null as a value to clear one and fall back to automatic resolution. Also '
                    + 'accepts image_quality (draft/standard/precision/auto) and image_model. '
                    + 'A project that pins nothing resolves through your account default and then '
                    + 'through a built-in preference order, which may pick a vendor you never chose — '
                    + 'so pin the ones that matter.',
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
        // Only what was sent: `fountain: undefined` alongside a delivery
        // direction would splice an empty scene, and an advertised argument no
        // builder forwards is one a model sets and nothing reads.
        body: a => ({
            ...(a.fountain !== undefined ? { fountain: a.fountain } : {}),
            ...(a.delivery_direction !== undefined ? { delivery_direction: a.delivery_direction } : {}),
        }),
        schema: {
            scene_id: { type: 'string' },
            fountain: { type: 'string', description: 'The complete scene in Fountain, heading first, action and dialogue beneath.' },
            delivery_direction: { type: 'string', description: 'How this SCENE is played \u2014 "tense, hushed", "shouting over each other". Applies to every line in it that carries no parenthetical of its own, and is beaten by one that does. Sent alone (without `fountain`) it changes only this, and splices nothing.' },
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
    /*
     * Reading a screenplay.
     *
     * Deliberately a PAIR rather than a single "analyse this" tool. The
     * connected model is the one that reads: a tool that called a server-side
     * LLM would ask for a second API key to answer a question this model has
     * already read the material for, and would fail with a billing error the
     * model cannot act on. So the engine hands over a brief and stores the
     * conclusion. tests/mcp-no-server-llm.test.js enforces it.
     */
    /*
     * The subject workspace.
     *
     * Every picture of a character, location or prop used to be a candidate
     * reference — there was nowhere to keep an image that INFORMS the work
     * without BEING it. These carry a role, and only an approved reference is
     * ever sent to a provider.
     */
    /*
     * Casting, and hearing a line before anything is shot.
     *
     * Dialogue generation shipped in phase 4 and could only be reached per
     * SHOT — which means after a breakdown, which is after the point where
     * hearing it would change what you write.
     */
    {
        name: 'voice_catalogue',
        handler: handleVoiceCasting, method: 'GET',
        description: 'Every voice this ElevenLabs account can use, with gender, age, accent and a PREVIEW URL the provider hosts. The preview costs nothing to play, which is what makes this a casting session rather than a dropdown of names. SPENDS NOTHING.',
        path: a => `/film/voices${a.refresh ? '?refresh=true' : ''}`,
        schema: { refresh: { type: 'boolean', description: 'Skip the ten-minute cache.' } },
        required: [],
    },
    {
        name: 'voice_cast',
        handler: handleVoiceCasting, method: 'PUT',
        description: 'Cast a character in a voice. This is what every line of theirs is then spoken in — auditions, the table read, and the dialogue that ships. An UNCAST character is not an error: their lines generate in the provider\u2019s default voice, which sounds like a decision rather than an omission, so cast everyone who speaks. Read voice_catalogue first to choose a voice_id. SPENDS NOTHING.',
        path: a => `/film/characters/${a.character_id}/voice`,
        body: a => ({ voice_id: a.voice_id, voice_name: a.voice_name, cast_note: a.cast_note }),
        schema: {
            character_id: { type: 'string' },
            voice_id: { type: 'string', description: 'From voice_catalogue.' },
            voice_name: { type: 'string' },
            cast_note: { type: 'string', description: 'Why this voice — the line you judged it on, so the choice has a reason three weeks later.' },
        },
        required: ['character_id', 'voice_id'],
    },
    {
        name: 'casting_report',
        handler: handleVoiceCasting, method: 'GET',
        description: 'Who is cast and who is not, ordered by how many lines they have — so the uncast list is ordered by what it costs to leave uncast rather than alphabetically. SPENDS NOTHING.',
        path: a => `/film/projects/${a.project_id}/casting`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'voice_audition_preview',
        handler: handleVoiceCasting, method: 'GET',
        description: 'What an audition would send, and in whose voice, before anything is spent. Warns when no voice is resolved, because the result would be the provider default and sound like a choice. SPENDS NOTHING.',
        path: a => `/film/audition/preview?text=${encodeURIComponent(a.text || '')}`
            + (a.voice_id ? `&voice_id=${encodeURIComponent(a.voice_id)}` : '')
            + (a.character_id ? `&character_id=${encodeURIComponent(a.character_id)}` : ''),
        schema: {
            text: { type: 'string' },
            voice_id: { type: 'string' },
            character_id: { type: 'string', description: 'Use this character\u2019s cast voice.' },
        },
        required: ['text'],
    },
    {
        name: 'voice_audition',
        handler: handleVoiceCasting, method: 'POST',
        description: 'SPENDS MONEY. Hear one line spoken, ATTACHED TO NOTHING. This is the planning-phase tool: try a line, try a voice, hear how it feels, before any shot exists. It registers no asset and names no shot, so the pipeline can never mistake a reading you were trying out for the take that ships. Pass character_id to use that character\u2019s cast voice, or voice_id to try one.',
        path: () => '/film/audition',
        body: a => ({ text: a.text, voice_id: a.voice_id, character_id: a.character_id,
            project_id: a.project_id, speed: a.speed, stability: a.stability }),
        schema: {
            text: { type: 'string', description: 'The line to speak.' },
            voice_id: { type: 'string' },
            character_id: { type: 'string' },
            project_id: { type: 'string' },
            speed: { type: 'number' },
            stability: { type: 'number' },
        },
        required: ['text'],
    },
    {
        name: 'table_read_get',
        handler: handleVoiceCasting, method: 'GET',
        description: 'A scene\u2019s spoken lines in order, with who says each and which voice they are cast in. A parenthetical travels BESIDE its line as direction rather than inside it, because read aloud "(quietly) Get inside." becomes "quietly, get inside". Names anyone in the scene who is not cast. SPENDS NOTHING.',
        path: a => `/film/scenes/${a.scene_id}/table-read`,
        schema: { scene_id: { type: 'string' } }, required: ['scene_id'],
    },
    {
        name: 'table_read',
        handler: handleVoiceCasting, method: 'POST',
        description: 'SPENDS MONEY. Generate every spoken line in a scene, each in its character\u2019s cast voice — a table read, before the breakdown. Attached to no shot. Generated sequentially, and a provider that starts refusing stops the read with the lines not attempted NAMED, because a partial read reported as success is how somebody listens to four lines of a seven-line scene and concludes the scene is short. Read table_read_get first to see the lines and the casting.',
        path: a => `/film/scenes/${a.scene_id}/table-read`,
        body: () => ({}),
        schema: { scene_id: { type: 'string' } }, required: ['scene_id'],
    },
    {
        name: 'gallery_get',
        handler: handleSubjectGallery, method: 'GET',
        description: 'Every picture of one character, location or prop, grouped by role. reference = the approved plate, and the ONLY thing that conditions a frame (one per view). concept = an exploration, kept and comparable, reaching no prompt until promoted. inspiration = gathered rather than made — a film still, a photograph, the real location — excluded from generation because sending somebody else\u2019s image to a provider is a different act from looking at it. SPENDS NOTHING.',
        path: a => `/film/${a.kind}s/${a.subject_id}/gallery`,
        schema: {
            kind: { type: 'string', description: 'character | location | prop' },
            subject_id: { type: 'string' },
        },
        required: ['kind', 'subject_id'],
    },
    {
        name: 'gallery_explore_preview',
        handler: handleSubjectGallery, method: 'GET',
        description: 'What an exploration would send, and at what size, before anything is spent. Reports the resolved provider and whether it will honour the requested resolution at all. SPENDS NOTHING.',
        path: a => `/film/${a.kind}s/${a.subject_id}/explore/preview?count=${a.count || 3}`
            + (a.view ? `&view=${encodeURIComponent(a.view)}` : '')
            + (a.instruction ? `&instruction=${encodeURIComponent(a.instruction)}` : ''),
        schema: {
            kind: { type: 'string', description: 'character | location | prop' },
            subject_id: { type: 'string' },
            count: { type: 'number', description: '1-6. Default 3.' },
            view: { type: 'string', description: 'For a character: front, side, back. For a location: a named view.' },
            instruction: { type: 'string', description: 'The look to try — "older, scarred", "at night, wet". Added to the subject\u2019s own prompt rather than replacing it.' },
        },
        required: ['kind', 'subject_id'],
    },
    {
        name: 'gallery_explore',
        handler: handleSubjectGallery, method: 'POST',
        description: 'SPENDS MONEY. Generate several looks for one subject, kept side by side as CONCEPTS. The approved plate is untouched: explorations are written to their own filenames and reach no prompt until one is promoted with gallery_promote. Generated sequentially — several image calls at one provider is how a queue earns a 429 — and a provider that starts refusing stops the run rather than being asked again, with the looks not attempted named. Preview it free with gallery_explore_preview first.',
        path: a => `/film/${a.kind}s/${a.subject_id}/explore`,
        body: a => ({ count: a.count, view: a.view, instruction: a.instruction }),
        schema: {
            kind: { type: 'string', description: 'character | location | prop' },
            subject_id: { type: 'string' },
            count: { type: 'number', description: '1-6. Default 3.' },
            view: { type: 'string' },
            instruction: { type: 'string', description: 'The look to try.' },
        },
        required: ['kind', 'subject_id'],
    },
    {
        name: 'gallery_inspire',
        handler: handleSubjectGallery, method: 'POST',
        description: 'Keep an image with a subject as INSPIRATION — a film still, a photograph, a painting, the real location. Either a data URI (PNG, JPEG or WebP) or an http(s) link; a link is stored as a link and given no file, because inventing a path makes the serving route 404 on something that was never a file. Recorded with rights unknown and license_source external, and it reaches NO prompt: it informs the artist, not the model. Promoting one to a reference is possible and has to be stated.',
        path: a => `/film/${a.kind}s/${a.subject_id}/inspiration`,
        body: a => ({ data: a.data, source_url: a.source_url, note: a.note, view: a.view }),
        schema: {
            kind: { type: 'string', description: 'character | location | prop' },
            subject_id: { type: 'string' },
            data: { type: 'string', description: 'data:image/png;base64,... — for a file you hold.' },
            source_url: { type: 'string', description: 'An http(s) link — for something online.' },
            note: { type: 'string', description: 'What you are taking from it: "the wing silhouette", "this grade".' },
            view: { type: 'string' },
        },
        required: ['kind', 'subject_id'],
    },
    {
        name: 'gallery_promote',
        handler: handleSubjectGallery, method: 'PUT',
        description: 'Set what a picture IS. role=reference makes it the approved plate for its view — what every frame of this subject is generated from — and demotes whatever held that view back to a concept rather than deleting it, because the picture it replaced cost money and may be the one you come back to. role=concept puts it back in the sketchbook, and says so if that leaves the subject with NO reference, since every frame would then invent it. Promoting an inspiration needs allow_inspiration: true.',
        path: a => `/film/gallery/${a.asset_id}/role`,
        body: a => ({ role: a.role, allow_inspiration: a.allow_inspiration }),
        schema: {
            asset_id: { type: 'string' },
            role: { type: 'string', description: 'reference | concept | inspiration' },
            allow_inspiration: { type: 'boolean', description: 'Required to promote a gathered image to a conditioning reference.' },
        },
        required: ['asset_id', 'role'],
    },
    {
        name: 'gallery_remove',
        handler: handleSubjectGallery, method: 'DELETE',
        description: 'Remove one picture from a subject. The row goes; the bytes move to a deleted/ folder rather than being unlinked, because a generated plate cost money. Warns if it was the last approved reference.',
        path: a => `/film/gallery/${a.asset_id}`,
        schema: { asset_id: { type: 'string' } }, required: ['asset_id'],
    },
    {
        name: 'analysis_brief',
        handler: handleStoryDevelopment, method: 'GET',
        description: 'Everything needed to read this screenplay properly, in one call, and it SPENDS NOTHING: the full screenplay text, the thirteen-dimension rubric merged from the Academy Nicholl scoring rubric and the Sundance curriculum (premise, structure, causality, character, conflict, scene function, pacing, dialogue, visual storytelling, theme, tone, voice, format), the four output layers, the note schema, and the mechanical findings the engine already computed so you do not have to count anything. YOU do the reading — this returns no judgement. Then write it back with analysis_write. Central rule: DIAGNOSE BEFORE PRESCRIBING. Say what a reader experiences and why, cite a scene or page for every observation, and hand the decision back to the writer rather than telling them what story to write. Never draft replacement dialogue or scene description: generated prose can disqualify a screenplay from competitions that prohibit AI-written material.',
        path: a => `/film/projects/${a.project_id}/analysis/brief`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'analysis_write',
        handler: handleStoryDevelopment, method: 'POST',
        description: 'Store a reading of the screenplay, as the four layers: map (what is in the script), observations (patterns, each with evidence), questions (that let the writer test their intent), opportunities (prioritised, with likely impact). Every observation and opportunity must carry all seven fields — observation, evidence, effect, question, strategies, confidence (high|medium|low), kind (mechanical|interpretive) — and is REFUSED without them, because a note with no evidence cannot be checked and one with no question is a verdict. An overall score is refused: a number gets quoted without the reasoning that produced it. A note carrying rewritten prose is refused. Read analysis_brief first. TAG EVERY NOTE WITH ITS `dimension` \u2014 one of the thirteen ids in the brief (premise, structure, causality, character, conflict, scene_function, pacing, dialogue, visual, theme, tone, voice, format). It is how the report is READ: a writer working on dialogue wants the dialogue notes together, not scattered through a list. An untagged note still stores and is shown under "Not filed"; an unrecognised dimension is refused rather than filed nowhere.',
        path: a => `/film/projects/${a.project_id}/analysis`,
        body: a => ({
            analyst: a.analyst, map: a.map, observations: a.observations,
            questions: a.questions, opportunities: a.opportunities,
        }),
        schema: {
            project_id: { type: 'string' },
            analyst: { type: 'string', description: 'Who read it — a model name, or a person.' },
            map: { type: 'object', description: 'Characters, scenes, locations, chronology, goals, turning points, setups and payoffs.' },
            observations: { type: 'array', description: 'Notes. Each: observation, evidence, effect, question, strategies[], confidence, kind, and `dimension` \u2014 which of the thirteen the note is about.' },
            questions: { type: 'array', description: 'Development questions, as strings.' },
            opportunities: { type: 'array', description: 'Prioritised revision notes, same fields as an observation, `dimension` included.' },
        },
        required: ['project_id', 'map', 'observations', 'questions', 'opportunities'],
    },
    {
        name: 'analysis_get',
        handler: handleStoryDevelopment, method: 'GET',
        description: 'The last reading of this screenplay, or every reading with all=true. Says whether it is of the CURRENT draft: a report presented beside a screenplay it no longer describes is worse than none, because every note still reads as current. SPENDS NOTHING.',
        path: a => `/film/projects/${a.project_id}/analysis${a.all ? '?all=true' : ''}`,
        schema: { project_id: { type: 'string' }, all: { type: 'boolean' } },
        required: ['project_id'],
    },
    {
        name: 'analysis_delete',
        handler: handleStoryDevelopment, method: 'DELETE',
        description: 'Remove one stored reading.',
        path: a => `/film/analysis/${a.analysis_id}`,
        schema: { analysis_id: { type: 'string' } }, required: ['analysis_id'],
    },

    /*
     * The treatment: prose before the screenplay.
     *
     * Stored apart from film_scripts because it is not a screenplay — the
     * Fountain parser would read its paragraphs as action and manufacture
     * scenes from nothing, and every report built on scene presence would then
     * describe a document that has no scenes.
     */
    {
        name: 'treatment_get',
        handler: handleStoryDevelopment, method: 'GET',
        description: 'The treatment: prose stating what happens, in order, without dialogue or screenplay format. This is what a screenplay is written FROM. Returns the latest version and its word count. SPENDS NOTHING.',
        path: a => `/film/projects/${a.project_id}/treatment`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'treatment_write',
        handler: handleStoryDevelopment, method: 'PUT',
        description: 'Save a NEW version of the treatment. Versioned, so the draft you replaced is kept. An unchanged save writes nothing and reports changed:false, so "did that apply?" is a free question. To draft the screenplay FROM a treatment: read it with treatment_get, write the Fountain yourself, and save it with script_write — the treatment is the source, and this engine never generates the screenplay for you.',
        path: a => `/film/projects/${a.project_id}/treatment`,
        body: a => ({ content: a.content, title: a.title }),
        schema: {
            project_id: { type: 'string' },
            content: { type: 'string', description: 'The treatment prose.' },
            title: { type: 'string' },
        },
        required: ['project_id', 'content'],
    },
    {
        name: 'treatment_versions',
        handler: handleStoryDevelopment, method: 'GET',
        description: 'Every version of the treatment, newest first. SPENDS NOTHING.',
        path: a => `/film/projects/${a.project_id}/treatment/versions`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'treatment_delete',
        handler: handleStoryDevelopment, method: 'DELETE',
        description: 'Remove the LATEST treatment version, leaving the earlier ones. Deleting the whole history to undo one save is not what this does.',
        path: a => `/film/projects/${a.project_id}/treatment`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },

    {
        name: 'script_timing',
        handler: handleStoryDevelopment, method: 'GET',
        description: 'Three separate numbers per scene, and the reason they are separate. page_eighths is how much printed page the scene occupies (objective, written the way a stripboard writes it: 4/8, never 1/2). screen_time is a RANGE with a confidence for how long it plays. production is how hard it is to SHOOT, which is independent of both — "The bridge explodes." is 1/8 of a page and can eat a shooting day. Where the page-per-minute rule disagrees with what the scene actually contains, the scene carries a disagreement saying which and why, rather than the two being averaged into one number that hides the method. Also flags phrases whose duration the page does not state ("They fight.", "Time passes.") — not bad writing, simply unreliable to schedule against. SPENDS NOTHING.',
        path: a => `/film/projects/${a.project_id}/timing${a.delivery ? `?delivery=${a.delivery}` : ''}`,
        schema: {
            project_id: { type: 'string' },
            delivery: { type: 'string', description: 'ceremonial | ordinary | rapid | overlapping — the dialogue rate to time against. Default ordinary.' },
        },
        required: ['project_id'],
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
        description: 'Create shots for one scene from an array of scene cards. Each card needs shot_code plus camera {shot_type, movement, lens}, lighting {type}, description, duration_seconds, and characters/dialogue where present. Name every character that appears \u2014 that is how their appearance reaches the prompt. A card may also carry environment_motion (what the WORLD does during the shot: rain, a swinging door, flames, debris \u2014 taken from the screenplay\u2019s action lines, omitted unless something actually moves, and never a description of the place, which the frame already shows), end_state (where things must be when the clip ends) and beats (ordered stages, only for a shot that genuinely evolves). All three reach the VIDEO prompt; a still cannot show any of them.',
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
        name: 'shot_motion',
        handler: handlePrevis, method: 'GET',
        description: 'What camera move this shot plays over its storyboard frame, and what showing it costs. '
            + 'FREE — it reads rows and does arithmetic, so trying an angle is a question of taste rather than of budget. '
            + 'Reads the shot\'s previs blocking if it has any, otherwise the movement written on its card, otherwise nothing. '
            + 'Returns the transform track playback uses, plus: `magnification` (how tight the still is ever shown — a travelling '
            + 'move has to push into the frame to have room), `carried` (false when the move is too big for a still to show honestly), '
            + 'and `perceptible` (false when the move is real but will not read at this framing). '
            + 'A still holds no parallax: the subject comes out right and the background travels with it.',
        path: a => `/film/shots/${a.shot_id}/motion`,
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
        name: 'spend_record',
        handler: handleBudget, method: 'POST',
        path: a => `/film/projects/${a.project_id}/spend/record`,
        /*
         * Without this the dispatcher sends an EMPTY body: a route tool that
         * declares neither `body` nor `bodyKeys` posts `{}`, so every field was
         * dropped and the route refused its own arguments as missing. The
         * schema being right is not the same as the arguments arriving.
         */
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        description:
            'Record a charge the engine did not observe. Everything else in the ledger is measured '
            + 'at the moment of a call, which misses real money: a generation that was rendered and '
            + 'BILLED and then lost on this side (the meter correctly declines to bill refusals, so '
            + 'it records nothing for a charge that already happened), anything bought before the '
            + 'metering path covered it, or a charge made outside the engine entirely. ALWAYS '
            + 'FLAGGED as hand-entered, so it can never be mistaken for something the engine '
            + 'watched happen. Supply `usd` when you have the provider\u2019s own figure \u2014 an invoice '
            + 'beats our reconstruction of it; omit it and the rate book prices the quantity.',
        schema: {
            project_id: { type: 'string' },
            provider: { type: 'string', description: 'e.g. seedance, meshy, elevenlabs.' },
            capability: { type: 'string', description: 'video, image, music, ambient, llm, post\u2026' },
            model: { type: 'string', description: 'The model actually billed, e.g. seedance-2.5-1080p.' },
            unit: { type: 'string', description: 'second, call, credit, token. Default call.' },
            quantity: { type: 'number', description: 'How many units. Required.' },
            usd: { type: 'number', description: 'The exact charge, when known. Omit to price from the rate book.' },
            shot_id: { type: 'string' },
            note: { type: 'string', description: 'Why this is being entered by hand \u2014 it is stored with the row.' },
            reference: { type: 'string', description: 'The provider\u2019s job or invoice id, so it can be reconciled later.' },
        },
        required: ['project_id', 'provider', 'capability', 'quantity'],
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
        name: 'spend_compare',
        handler: handleBudget, method: 'GET',
        description:
            'Compare every generator that can produce images or video, priced against ONE UNIT OF '
            + 'REAL WORK so the numbers are commensurable \u2014 the providers do not bill in the same '
            + 'unit (Runway and OpenAI per image, Meshy per call, BFL per megapixel, video per '
            + 'second), so a raw rate cannot be ranked. FREE: reads the registries, generates '
            + 'nothing. Each row carries the price for one frame or clip, the price for a scene of '
            + 'them, whether a credential exists (a price you cannot use is not a choice, so '
            + 'uncredentialed providers are listed and marked rather than hidden), the source URL '
            + 'and the date the rate was checked. A row marked inferred was not published by the '
            + 'provider. A self-hosted row is $0 because nobody bills for it, NOT because it is '
            + 'cheap. Cheapest is not best: the tier badge says what a model is FOR \u2014 a draft '
            + 'model exists to be rolled repeatedly, a precision one to be right once. Pass '
            + 'project_id to price per-megapixel providers against that film\u2019s delivery frame.',
        path: a => {
            const q = [`capability=${encodeURIComponent(a.capability || 'image')}`];
            if (a.project_id) q.push(`project_id=${a.project_id}`);
            if (a.clip_seconds) q.push(`clip_seconds=${a.clip_seconds}`);
            return `/film/spend/compare?${q.join('&')}`;
        },
        schema: {
            capability: { type: 'string', enum: ['image', 'video'],
                description: 'Which generators to compare. Defaults to image.' },
            project_id: { type: 'string',
                description: 'Optional. Supplies the delivery frame, without which the '
                    + 'per-megapixel providers cannot be priced honestly.' },
            clip_seconds: { type: 'number',
                description: 'Optional, video only. Length of the clip to price. Defaults to 5.' },
        },
        required: [],
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
        name: 'music_brief',
        handler: handleMusicGen, method: 'GET',
        description: 'Everything the engine knows about a scene, for deciding what it should SOUND like: the heading, what happens, who is in it, how many lines of dialogue, how many shots, the film\u2019s genre and the musical clauses of its look — plus the real length of the cut and where that number came from. It returns NO conclusion: what a scene should sound like is a judgement, and you are the model here. Decide the mood, genre, instruments and a reference track, then store them with music_cue_create; a cue somebody wrote always beats the derivation. Watch the dialogue count — a wall-to-wall dialogue scene wants sparse underscore that never becomes melodic, because a melody there fights the words. SPENDS NOTHING.',
        path: a => `/film/scenes/${a.scene_id}/music/brief`,
        schema: { scene_id: { type: 'string' } }, required: ['scene_id'],
    },
    {
        name: 'music_cue_create',
        handler: handleAssets, method: 'POST',
        description: 'Write the brief for a piece of music \u2014 the direction, not the generation. '
            + 'WHAT REACHES THE GENERATOR: description (the free text, and the field that matters most), '
            + 'mood, genre, instruments, tempo_bpm, key_signature and reference_track. `notes` is '
            + 'production-facing and reaches NOTHING, so do not put the brief there. '
            + 'In `description`, say what the music DOES against the scene \u2014 "holds under the '
            + 'dialogue, lifts when she stands, out on the door" \u2014 not only what it sounds like; '
            + 'the mood and genre already carry that. `reference_track` is sent as a style to match '
            + '("in the style of X"), which is the clearest single note a director gives. '
            + 'OMIT duration_ms and the cue is scored to the MEASURED length of that scene\u2019s '
            + 'footage; set it only to run deliberately past or under the cut. '
            + 'To shape the cue OVER TIME rather than describing it all at once, write `sections`: '
            + 'each has a name, a direction and a length of 3\u2013120s, and the generator honours '
            + 'those lengths. `negative_prompt` says what it must NOT be.',
        path: a => `/film/projects/${a.project_id}/music-cues`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            project_id: { type: 'string' },
            scene_id: { type: 'string', description: 'The scene this cue plays over. Required for the '
                + 'length to be measured from real footage.' },
            title: { type: 'string' },
            cue_type: { type: 'string', enum: ['score', 'source', 'sfx', 'ambient', 'transition'] },
            description: { type: 'string', description: 'The free text that REACHES the generator. '
                + 'What the music does against the scene.' },
            mood: { type: 'string', description: 'Reaches the generator, and sets tempo and instrument '
                + 'defaults when those are left blank.' },
            genre: { type: 'string', description: 'Reaches the generator.' },
            instruments: { type: 'array', items: { type: 'string' },
                description: 'Reaches the generator. A list, e.g. ["solo cello","brushed kit"].' },
            tempo_bpm: { type: 'number', description: 'Reaches the generator.' },
            key_signature: { type: 'string', description: 'Reaches the generator, e.g. "D minor".' },
            reference_track: { type: 'string', description: 'Reaches the generator as "in the style of X".' },
            duration_ms: { type: 'number', description: 'OMIT to score the measured length of the '
                + 'scene\u2019s footage \u2014 that is almost always what you want. Set it only to run '
                + 'deliberately past or under the cut.' },
            notes: { type: 'string', description: 'Production notes. Reaches NO generator.' },
            negative_prompt: { type: 'string', description: 'What the cue must NOT be, sent to the '
                + 'generator as a negative: "vocals, drums, sentimental strings". A note a composer '
                + 'gives constantly and that had nowhere to live.' },
            sections: {
                type: 'array',
                description: 'Shape the cue OVER TIME instead of describing the whole thing at once. '
                    + 'Each section gets its own direction and its own length, and the generator '
                    + 'honours those lengths \u2014 so "sparse under the argument, then it opens out '
                    + 'when he finally says it" becomes two sections rather than one hopeful sentence. '
                    + 'A section is 3s to 120s; the cue is the SUM of its sections, so omit '
                    + 'duration_ms when you write these. Leave this empty and the cue sends one '
                    + 'prompt for its whole length, exactly as before.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'How you refer to it, e.g. "under the argument".' },
                        direction: { type: 'string', description: 'What this part of the cue does.' },
                        seconds: { type: 'number', description: 'How long this part runs. 3 to 120.' },
                        negative: { type: 'string', description: 'What this part must not be, e.g. "drums".' },
                    },
                },
            },
        },
        required: ['project_id'],
    },
    {
        name: 'music_cue_list',
        handler: handleAssets, method: 'GET',
        description: 'The music briefs on a project, with what each one would be generated from.',
        path: a => `/film/projects/${a.project_id}/music-cues`
            + (a.cue_type ? `?cue_type=${encodeURIComponent(a.cue_type)}` : ''),
        schema: {
            project_id: { type: 'string' },
            cue_type: { type: 'string', enum: ['score', 'source', 'sfx', 'ambient', 'transition'] },
        },
        required: ['project_id'],
    },
    {
        name: 'music_cue_generate',
        handler: handleMusicGen, method: 'POST',
        path: a => `/film/music-cues/${a.cue_id}/generate`,
        body: a => { const { cue_id, ...rest } = a || {}; return rest; },
        description:
            'SPENDS MONEY. Generate the cue you WROTE \u2014 the score, the source music or the '
            + 'ambient bed on that row \u2014 and store it as an asset linked back to the cue. '
            + 'ADDRESSED BY CUE, not by scene, because a scene holds several cues at once and a '
            + 'scene-addressed call has to guess which one you meant. Use this rather than '
            + '`node_gen_music`: that node derives its own prompt from the scene and never reads '
            + 'your cue, so a written orchestral score comes back as a scene-derived bed. Read '
            + '`music_brief` first \u2014 it is free and shows the prompt this will send. An SFX '
            + 'cue is refused here and named: effects are generated from a shot\u2019s scene card.',
        schema: {
            cue_id: { type: 'string', description: 'The cue to generate. From music_cue_list.' },
            direction: { type: 'string', description: 'Ambient only: overrides the cue\u2019s description for this run.' },
            negative_prompt: { type: 'string', description: 'What the generation must avoid, for this run.' },
        },
        required: ['cue_id'],
    },
    {
        name: 'music_cue_update',
        handler: handleAssets, method: 'PUT',
        description: 'Revise a cue. MERGED, never replaced \u2014 rewriting one sentence of direction '
            + 'cannot clear the instruments or the reference. Use this to refine a brief rather than '
            + 'creating a second cue for the same moment.',
        path: a => `/film/music-cues/${a.cue_id}`,
        body: a => { const { cue_id, ...rest } = a || {}; return rest; },
        schema: {
            cue_id: { type: 'string' },
            title: { type: 'string' }, description: { type: 'string' },
            mood: { type: 'string' }, genre: { type: 'string' },
            instruments: { type: 'array', items: { type: 'string' } },
            tempo_bpm: { type: 'number' }, key_signature: { type: 'string' },
            reference_track: { type: 'string' }, duration_ms: { type: 'number' },
            cue_type: { type: 'string', enum: ['score', 'source', 'sfx', 'ambient', 'transition'] },
            notes: { type: 'string' },
            negative_prompt: { type: 'string', description: 'What the cue must NOT be, sent to the '
                + 'generator as a negative: "vocals, drums, sentimental strings". A note a composer '
                + 'gives constantly and that had nowhere to live.' },
            sections: {
                type: 'array',
                description: 'Shape the cue OVER TIME instead of describing the whole thing at once. '
                    + 'Each section gets its own direction and its own length, and the generator '
                    + 'honours those lengths \u2014 so "sparse under the argument, then it opens out '
                    + 'when he finally says it" becomes two sections rather than one hopeful sentence. '
                    + 'A section is 3s to 120s; the cue is the SUM of its sections, so omit '
                    + 'duration_ms when you write these. Leave this empty and the cue sends one '
                    + 'prompt for its whole length, exactly as before.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'How you refer to it, e.g. "under the argument".' },
                        direction: { type: 'string', description: 'What this part of the cue does.' },
                        seconds: { type: 'number', description: 'How long this part runs. 3 to 120.' },
                        negative: { type: 'string', description: 'What this part must not be, e.g. "drums".' },
                    },
                },
            },
        },
        required: ['cue_id'],
    },
    {
        name: 'music_cue_delete',
        handler: handleAssets, method: 'DELETE',
        description: 'Remove a cue. Any audio generated from it is KEPT \u2014 it is an asset on the '
            + 'scene and cost money to make.',
        path: a => `/film/music-cues/${a.cue_id}`,
        schema: { cue_id: { type: 'string' } },
        required: ['cue_id'],
    },
    {
        name: 'stylebook_list',
        handler: handleStyleBook, method: 'GET',
        description: 'The director\u2019s style book: named shots they like, with camera details and '
            + 'reference visuals. CROSS-PROJECT \u2014 entries with scope "library" are visible from every '
            + 'film and accumulate into a directing style; scope "project" is a variant specific to one. '
            + 'Pass project_id to see that project\u2019s entries plus the library. FREE. The VISUALS are '
            + 'reference for a person: a style still is the lowest-ranked reference kind and is dropped '
            + 'before the request is built on any shot with a cast and a location, and a clip reaches no '
            + 'generator at all. What reaches a picture is the camera facets, applied to a shot card.',
        path: a => (a.project_id ? `/film/projects/${a.project_id}/style-book` : '/film/style-book'),
        schema: {
            project_id: { type: 'string', description: 'Optional. Without it you see only the library.' },
        },
        required: [],
    },
    {
        name: 'stylebook_get',
        handler: handleStyleBook, method: 'GET',
        description: 'One style-book entry with its camera facets and its visuals.',
        path: a => `/film/style-book/${a.entry_id}`,
        schema: { entry_id: { type: 'string' } },
        required: ['entry_id'],
    },
    {
        name: 'stylebook_create',
        handler: handleStyleBook, method: 'POST',
        description: 'Record a shot in the style book. `camera` takes the SAME facets a scene card '
            + 'carries (shot_type, movement, lens, sensor, aperture, focus_distance_m, height_m, note) '
            + 'and every one is optional \u2014 "85mm, that is all I know" is a legitimate entry. '
            + 'height_m is the facet that makes a low-angle sayable, and is worth setting whenever the '
            + 'angle is the point. Defaults to scope "library", because a directing style accumulates '
            + 'across films. Validated against the scene card, so what this accepts a card accepts.',
        path: a => (a.project_id ? `/film/projects/${a.project_id}/style-book` : '/film/style-book'),
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            project_id: { type: 'string', description: 'Required only for scope "project".' },
            name: { type: 'string', description: 'What you call this shot, e.g. "Ozu tatami low-angle".' },
            description: { type: 'string' },
            tags: { type: 'string', description: 'Free text. Search terms you would actually use.' },
            scope: { type: 'string', enum: ['library', 'project'] },
            camera: { type: 'object', description: 'Scene-card camera facets. position/rotation are NOT '
                + 'carried: a stage pose means nothing in another scene.' },
        },
        required: ['name'],
    },
    {
        name: 'stylebook_update',
        handler: handleStyleBook, method: 'PUT',
        description: 'Change an entry. MERGED, never replaced: renaming one cannot clear its camera, '
            + 'and a camera facet set to null is removed.',
        path: a => `/film/style-book/${a.entry_id}`,
        body: a => { const { entry_id, ...rest } = a || {}; return rest; },
        schema: {
            entry_id: { type: 'string' },
            name: { type: 'string' }, description: { type: 'string' }, tags: { type: 'string' },
            scope: { type: 'string', enum: ['library', 'project'] },
            camera: { type: 'object' },
        },
        required: ['entry_id'],
    },
    {
        name: 'stylebook_delete',
        handler: handleStyleBook, method: 'DELETE',
        description: 'Remove an entry and its visuals.',
        path: a => `/film/style-book/${a.entry_id}`,
        schema: { entry_id: { type: 'string' } },
        required: ['entry_id'],
    },
    {
        name: 'stylebook_apply',
        handler: handleStyleBook, method: 'POST',
        description: 'Apply a style-book entry to a shot \u2014 the step that makes the book worth '
            + 'having. It MERGES the entry\u2019s camera facets onto that shot\u2019s scene card, which is '
            + 'already what the image and video prompt builders read, so a favourite angle reaches the '
            + 'next generation with nothing else to change. The card\u2019s description, dialogue and cast '
            + 'survive untouched, and a facet the entry says nothing about is left alone. Reports which '
            + 'facets it applied and which it skipped. Regenerate the frame afterwards to see it.',
        path: a => `/film/shots/${a.shot_id}/style-book/${a.entry_id}`,
        body: () => ({}),
        schema: { shot_id: { type: 'string' }, entry_id: { type: 'string' } },
        required: ['shot_id', 'entry_id'],
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
        name: 'brand_list',
        handler: handleBrands, method: 'GET',
        description: 'Every brand kit, with the field registry that says what each field REACHES \u2014 a prompt, a compliance check, the Premiere handoff, or a person. A brand OUTLIVES a project, like the style book: one client buys many spots. Only tone and palette reach a generation; the CTA, the legal line and the fonts are words and type placed in Premiere, because asking a diffusion model for legible text bakes a smudge into a frame you paid for.',
        path: () => '/film/brands',
        schema: {}, required: [],
    },
    {
        name: 'brand_get',
        handler: handleBrands, method: 'GET',
        description: 'One brand kit and the field registry.',
        path: a => `/film/brands/${a.brand_id}`,
        schema: { brand_id: { type: 'string' } }, required: ['brand_id'],
    },
    {
        name: 'brand_create',
        handler: handleBrands, method: 'POST',
        description: 'Create a brand kit. Palette entries must be #rrggbb \u2014 a CSS colour NAME is understood by a browser and not agreed on by a print document, an export and a contrast calculation. cta_url must be http(s), because it is rendered as a link.',
        path: () => '/film/brands',
        body: a => ({ ...a }),
        schema: {
            name: { type: 'string' },
            tone: { type: 'string', description: 'How the film should FEEL. The one brand field that is a look rather than a word, and it reaches the prompt.' },
            palette: { type: 'string', description: 'JSON array of #rrggbb strings.' },
            fonts: { type: 'string', description: 'JSON array of {role, family, weight}. Set in Premiere, never generated.' },
            cta: { type: 'string' }, cta_url: { type: 'string' },
            legal_line: { type: 'string' },
            banned_phrases: { type: 'string', description: 'JSON array of phrases refused in the copy before anything generates.' },
            logo_asset_id: { type: 'string' }, logo_clear_space: { type: 'string' },
            approval_contact: { type: 'string' }, notes: { type: 'string' },
        },
        required: ['name'],
    },
    {
        name: 'brand_update',
        handler: handleBrands, method: 'PUT',
        description: 'Change a brand kit. MERGES \u2014 a kit is a whole document, and a replace would drop what it was not asked about.',
        path: a => `/film/brands/${a.brand_id}`,
        body: a => { const b = { ...a }; delete b.brand_id; return b; },
        schema: {
            brand_id: { type: 'string' },
            name: { type: 'string' }, tone: { type: 'string' }, palette: { type: 'string' },
            fonts: { type: 'string' }, cta: { type: 'string' }, cta_url: { type: 'string' },
            legal_line: { type: 'string' }, banned_phrases: { type: 'string' },
            logo_asset_id: { type: 'string' }, logo_clear_space: { type: 'string' },
            approval_contact: { type: 'string' }, notes: { type: 'string' },
        },
        required: ['brand_id'],
    },
    {
        name: 'brand_delete',
        handler: handleBrands, method: 'DELETE',
        description: 'Delete a brand kit. It is shared across every project that points at it; those keep their pointer and lose the kit, and the count of them is reported.',
        path: a => `/film/brands/${a.brand_id}`,
        schema: { brand_id: { type: 'string' } }, required: ['brand_id'],
    },
    {
        name: 'claim_list',
        handler: handleBrands, method: 'GET',
        description: 'Every claim recorded for this project and its substantiation. An objective claim in a paid advertisement has to be substantiated \u2014 FTC, the Competition Act, the CAP Code and the ACCC all require it \u2014 and an automated pipeline can put one on screen in seconds, which is why the evidence is a ROW SOMEBODY SIGNED rather than a memory.',
        path: a => `/film/projects/${a.project_id}/claims`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'claim_create',
        handler: handleBrands, method: 'POST',
        description: 'Record a claim and its evidence. Status starts unsubstantiated: a row that EXISTS does not clear the compliance gate, only a SUBSTANTIATED one does, because a record is not evidence.',
        path: a => `/film/projects/${a.project_id}/claims`,
        body: a => ({ claim: a.claim, substantiation: a.substantiation, status: a.status, approved_by: a.approved_by }),
        schema: {
            project_id: { type: 'string' }, claim: { type: 'string' },
            substantiation: { type: 'string' },
            status: { type: 'string', description: 'unsubstantiated, substantiated or withdrawn.' },
            approved_by: { type: 'string' },
        },
        required: ['project_id', 'claim'],
    },
    {
        name: 'claim_update',
        handler: handleBrands, method: 'PUT',
        description: 'Change a claim or mark it substantiated. Marking it substantiated is what clears the gate, so it is a deliberate act with a name against it.',
        path: a => `/film/claims/${a.claim_id}`,
        body: a => { const b = { ...a }; delete b.claim_id; return b; },
        schema: {
            claim_id: { type: 'string' }, claim: { type: 'string' },
            substantiation: { type: 'string' }, status: { type: 'string' }, approved_by: { type: 'string' },
        },
        required: ['claim_id'],
    },
    {
        name: 'claim_delete',
        handler: handleBrands, method: 'DELETE',
        description: 'Remove a claim row. The COPY is untouched \u2014 deleting the evidence does not delete the claim from the script, so the compliance gate will flag that line again on the next run. Withdraw it instead if the claim itself is being dropped.',
        path: a => `/film/claims/${a.claim_id}`,
        schema: { claim_id: { type: 'string' } }, required: ['claim_id'],
    },
    {
        name: 'compliance_check',
        handler: handleBrands, method: 'GET',
        description: 'FREE. What is wrong with this spot BEFORE anything generates: a phrase the brand forbids, an objective claim with no substantiated row, a generated performer presented as a real customer, an uncleared or expired right. ERRORS block a run and warnings do not \u2014 a warning that stops a run makes the check something people switch off. Read this before run_plan: after generation the money is gone and the frames exist.',
        path: a => `/film/projects/${a.project_id}/compliance`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'deliverable_list',
        handler: handleDeliverables, method: 'GET',
        description: 'Every file that leaves this job, with the profiles and package names the route validates against. A film has none of these and behaves exactly as it always has; a commercial has fourteen to twenty-two. Read this before boarding a spot: the set is what says which ratios must be SHOT rather than cropped.',
        path: a => `/film/projects/${a.project_id}/deliverables`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'deliverable_plan',
        handler: handleDeliverables, method: 'POST',
        description: 'Apply a package preset (rapid, campaign, broadcast) and get one deliverable row per file. REPLACES the existing set unless append is true \u2014 a package is a statement about the whole job rather than an addition to it, so applying one twice should not leave twelve rows. `overrides` is keyed BY PROFILE ID, because a campaign that runs :20 on social and :30 on air is normal and a flat override would silently retime the broadcast master, whose length is contractual.',
        path: a => `/film/projects/${a.project_id}/deliverables/plan`,
        body: a => ({ package: a.package, append: a.append, overrides: a.overrides }),
        schema: {
            project_id: { type: 'string' },
            package: { type: 'string', description: 'rapid, campaign or broadcast.' },
            append: { type: 'boolean', description: 'Keep the existing rows and add to them.' },
            overrides: { type: 'object', description: 'Per-profile field overrides, e.g. { reels_15: { duration_ms: 20000 } }.' },
        },
        required: ['project_id', 'package'],
    },
    {
        name: 'deliverable_create',
        handler: handleDeliverables, method: 'POST',
        description: 'Add ONE hand-built deliverable. Use deliverable_plan for a standard package; this is for a placement no profile covers. `key` is the sequence name in Premiere and how Media Encoder queues it.',
        path: a => `/film/projects/${a.project_id}/deliverables`,
        body: a => { const b = { ...a }; delete b.project_id; return b; },
        schema: {
            project_id: { type: 'string' },
            key: { type: 'string' }, label: { type: 'string' },
            aspect_ratio: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' },
            fps: { type: 'number' }, duration_ms: { type: 'number' },
            platform: { type: 'string' }, loudness_target: { type: 'string' },
            caption_mode: { type: 'string', description: 'none, sidecar or burned.' },
            native: { type: 'boolean', description: 'Generated at this ratio rather than cropped to it.' },
            status: { type: 'string' }, notes: { type: 'string' },
        },
        required: ['project_id', 'key'],
    },
    {
        name: 'deliverable_update',
        handler: handleDeliverables, method: 'PUT',
        description: 'Change one deliverable. MERGES \u2014 a deliverable is a whole spec, and a replace would drop the fields you were not asked about.',
        path: a => `/film/deliverables/${a.deliverable_id}`,
        body: a => { const b = { ...a }; delete b.deliverable_id; return b; },
        schema: {
            deliverable_id: { type: 'string' },
            key: { type: 'string' }, label: { type: 'string' }, aspect_ratio: { type: 'string' },
            width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' },
            duration_ms: { type: 'number' }, platform: { type: 'string' },
            loudness_target: { type: 'string' }, caption_mode: { type: 'string' },
            native: { type: 'boolean' }, status: { type: 'string' }, notes: { type: 'string' },
        },
        required: ['deliverable_id'],
    },
    {
        name: 'deliverable_delete',
        handler: handleDeliverables, method: 'DELETE',
        description: 'Remove one deliverable. Nothing generated is affected \u2014 this is the list of files that leave the job.',
        path: a => `/film/deliverables/${a.deliverable_id}`,
        schema: { deliverable_id: { type: 'string' } }, required: ['deliverable_id'],
    },
    {
        name: 'deliverable_check',
        handler: handleDeliverables, method: 'GET',
        description: 'FREE verdict on the output set: what the cut currently runs against each deliverable\u2019s bought runtime, and which ratios must be SHOT native rather than cropped. `needs_native_shots` is the actionable line \u2014 a vertical placement with no shot flagged for it will be a crop of the 16:9 master, losing two-thirds of the width, and that is invisible until the client sees it.',
        path: a => `/film/projects/${a.project_id}/deliverables/check`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'export_preflight',
        handler: handleNLEExport, method: 'GET',
        description: 'What is wrong with this project\u2019s NLE export BEFORE anyone is handed it. FREE \u2014 nothing is written and nothing is generated. Blocking problems make the handover pointless (no shot can be laid on a timeline; a file the export names is not on disk); warnings are things an editor should be told and can work around (an audio lane with nothing in it yet, shots that will arrive as gaps, a scene bed with nowhere to be laid). Read this before export_package or before sending anybody an export: the commonest failure is a perfectly well-formed file describing NOTHING, because no shot has a duration.',
        path: a => `/film/projects/${a.project_id}/export/preflight`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'export_package',
        handler: handleNLEExport, method: 'GET',
        description: 'Write the NLE export AND the media it names into one folder, with the paths rewritten to point inside it. An ordinary export references media by absolute path, so handed to anybody else \u2014 another machine, a shared drive, a zip \u2014 it opens with every clip offline: the timeline is right and there is no picture. Media is COPIED, never moved. Refuses exactly what export_preflight blocks, and returns that preflight either way. `target` picks the format (premiere, fcpxml, edl); an EDL carries no media because it names reels rather than files.',
        path: a => `/film/projects/${a.project_id}/export/package${a.target ? `?target=${encodeURIComponent(a.target)}` : ''}`,
        schema: {
            project_id: { type: 'string' },
            target: { type: 'string', description: 'premiere (default), fcpxml or edl.' },
        },
        required: ['project_id'],
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
            category: {
                type: 'string',
                enum: PROP_CATEGORIES,
                description: 'One of the ten stored categories. A value outside this set is refused '
                    + 'by a database constraint, which is how the legal list used to be discovered.',
            },
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
            category: { type: 'string', enum: PROP_CATEGORIES },
            name: { type: 'string' },
            notes: { type: 'string', description: 'Production-facing. Reaches no prompt.' },
            materials: { type: 'string', description: 'What it is made of and how it catches light — "polished chrome, amber acrylic". Reaches the plate prompt.' },
            period: { type: 'string', description: 'When it is from. A 1952 selector and a 1998 one are different objects.' },
            quantity: { type: 'number', description: 'How many exist.' },
            practical: { type: 'boolean', description: 'Whether it has to WORK on camera — a practical is built differently and is a real production constraint.' },
            constraints: { type: 'string', description: 'What it must never be or do.' },
            continuity_states: {
                type: 'array',
                description: 'Clean, chipped, burnt — the versions of one object. Each needs a name; `what` describes the state and `scene` says where it belongs. A state with no name is refused.',
                items: { type: 'object', properties: {
                    name: { type: 'string' }, what: { type: 'string' }, scene: { type: 'string' } } },
            },
            materials_json: { type: 'array', description: 'Materials as rows: [{ name, role, hex }] \u2014 "amber acrylic", "panel, backlit", "#F0A828". The hex is the half a painter and an image model both need, and a comma string cannot carry it.' },
            constraints_json: { type: 'array', items: { type: 'string' }, description: 'What it must never be or do, as a list.' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'The few words that must survive into every frame \u2014 "no modern elements", "song cards legible". Written, never extracted: a parser guessing which phrases matter is wrong silently, in every frame.' },
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
            description: { type: 'string', description: 'Who they are and what they are for \u2014 the production-facing note, not the prompt.' },
            age_range: { type: 'string' },
            /*
             * THE REST OF THE SHEET.
             *
             * The route has accepted these since characters had a table, and
             * the sheet renders every one of them \u2014 but this tool declared
             * only four, so the fields a director actually fills in were
             * unreachable from here and stayed empty on every character in
             * every project. A tool that cannot fill the sheet it describes
             * makes the sheet look like a form nobody uses.
             */
            build: { type: 'string', description: 'Frame and carriage \u2014 "tall and lean, moves without hurry".' },
            hair: { type: 'string', description: 'Cut, colour and how it behaves \u2014 it is the first thing continuity loses.' },
            distinguishing: { type: 'string', description: 'The marks that identify this person in a frame: scars, asymmetry, a habitual set of the jaw.' },
            ethnicity: { type: 'string' },
            gender: { type: 'string' },
            personality_notes: { type: 'string', description: 'How they behave and what they never do. Reaches performance direction, not the image prompt.' },
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
            lighting_default: { type: 'string', description: 'How it is lit unless a shot says otherwise.' },
            time_of_day_default: { type: 'string', description: 'The hour it is shot at unless a scene says otherwise.' },
            atmosphere_notes: { type: 'string', description: 'Weather, haze, season — the standing conditions of the place.' },
            sound_notes: { type: 'string', description: 'How the place SOUNDS. Reaches the ambient bed generated for every scene here.' },
            location_type: { type: 'string', description: 'Interior, exterior, practical, stage.' },
            description_sections: { type: 'object', description: 'The set description as six named sections, keyed by id: layout, place, architecture, decoration, constraint, background. Six documents rather than one paragraph — each has its own length and folds on its own.' },
            continuity_flags: { type: 'array', items: { type: 'string' }, description: 'What must stay true in EVERY plate, as a list: "chalkboard stays blank", "window lettering reads reversed from inside".' },
            plate_plan: { type: 'array', description: 'The views this location is MEANT to have: [{ role, view, caption }]. An ungenerated one shows as a labelled empty slot rather than an absence nobody can see.' },
            orientation_plan: { type: 'object', description: 'Where things are by compass edge: { north, east, south, west, interior: [], marker }. This is what keeps four plates of one room describing the same room.' },
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
            /*
             * The motion fields. Read by the video prompt compiler, so an agent
             * that cannot set them cannot direct a clip — and this pipeline's
             * reasoning happens in an agent host.
             */
            environment_motion: { type: 'string', description: 'What the WORLD does while the subject acts \u2014 "flames erupt from the struck house; debris falls into the street". Reaches the video prompt on every provider; it is NOT the subject\u2019s action and NOT scenery, which the keyframe already shows.' },
            end_state: { type: 'string', description: 'Where things must BE when the clip ends \u2014 "the dragon fills the near foreground; Maya is small at the far kerb". Compiled into a closing clause, never sent as a labelled section.' },
            beats: { type: 'array', items: { type: 'string' }, description: 'Ordered subject beats for a shot that evolves, compiled as "First X, then Y". Write these ONLY when the shot genuinely has stages \u2014 micromanaging every second makes some models less reliable, and a shot needing more than a few beats is usually one that should be split.' },
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
        name: 'shot_review',
        description:
            'Hand over the pictures for a shot so YOU can look at them: the storyboard frame the '
            + 'director selected, and — when a clip has been generated — frames sampled across it '
            + '(start, quarter, half, three-quarter, end). This is how a shot gets validated without '
            + 'a server-side model: you compare the board against what came back and say what moved. '
            + 'Costs nothing. Returns the images alongside the shot card, so the words and the '
            + 'picture can be judged together.',
        schema: {
            shot_id: { type: 'string' },
            samples: { type: 'number', description: 'How many frames to sample from the clip (default 5, max 10).' },
        },
        required: ['shot_id'],
        async run(a) {
            const fsx = require('fs');
            const pathx = require('path');
            const { db } = require('../db/database');
            const { getFilePath } = require('./file-storage');

            const shot = db.prepare(
                `SELECT sh.*, s.project_id, s.scene_number
                   FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
                  WHERE sh.id = ?`).get(a.shot_id);
            if (!shot) return { status: 404, error: 'Shot not found' };

            const images = [];
            const notes = [];
            const asDataUri = (file, mime) => {
                try { return `data:${mime};base64,` + fsx.readFileSync(file).toString('base64'); }
                catch (_) { return null; }
            };

            /*
             * The frame the BOARD is showing, not the newest one. A shot with a
             * chosen version shows that version everywhere else; handing over a
             * different picture here would have the model validating a frame
             * nobody is looking at.
             */
            const wanted = shot.current_frame_version;
            const frameRow = db.prepare(
                `SELECT * FROM film_assets
                  WHERE shot_id = ? AND asset_type = 'storyboard'
                    ${wanted ? 'AND version = ?' : ''}
                  ORDER BY version DESC LIMIT 1`).get(...(wanted ? [a.shot_id, wanted] : [a.shot_id]));
            if (frameRow) {
                const p = getFilePath('storyboards', shot.project_id, frameRow.file_name);
                const uri = asDataUri(p, 'image/png');
                if (uri) images.push({ data_uri: uri, label: `storyboard ${shot.shot_code}` });
                else notes.push('the storyboard row exists but its file could not be read');
            } else {
                notes.push('no storyboard frame yet — generate the keyframe before validating a clip');
            }

            // Frames out of the clip, if there is one. ffmpeg is bundled, so
            // this is free; a missing encoder is reported rather than throwing.
            const clip = db.prepare(
                `SELECT * FROM film_assets WHERE shot_id = ?
                    AND asset_type IN ('video_final','video_synced','video_raw')
                  ORDER BY CASE asset_type WHEN 'video_final' THEN 0 WHEN 'video_synced' THEN 1 ELSE 2 END,
                           created_at DESC LIMIT 1`).get(a.shot_id);
            if (clip) {
                const { resolveFfmpeg, probe } = require('./ffmpeg');
                const bin = resolveFfmpeg();
                if (!bin || !bin.available) {
                    notes.push('a clip exists but no encoder is available to sample frames from it');
                } else {
                    const src = getFilePath('video', shot.project_id, clip.file_name);
                    let seconds = 0;
                    try { seconds = (probe(src) || {}).durationSeconds || 0; } catch (_) { seconds = 0; }
                    const n = Math.min(10, Math.max(2, Number(a.samples) || 5));
                    const dir = fsx.mkdtempSync(pathx.join(require('os').tmpdir(), 'fe-frames-'));
                    for (let i = 0; i < n; i++) {
                        const at = seconds ? (seconds * i) / (n - 1 || 1) : 0;
                        const out = pathx.join(dir, `f${i}.png`);
                        try {
                            require('child_process').execFileSync(bin.bin,
                                ['-y', '-ss', String(Math.max(0, at - 0.001)), '-i', src,
                                    '-frames:v', '1', '-q:v', '2', out],
                                { stdio: 'ignore', timeout: 20000 });
                            const uri = asDataUri(out, 'image/png');
                            if (uri) images.push({ data_uri: uri,
                                label: `clip ${Math.round((i / (n - 1 || 1)) * 100)}% (${at.toFixed(1)}s)` });
                        } catch (_) { /* one missing sample is not a failed call */ }
                    }
                    try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
                    if (images.length <= 1) notes.push('the clip could not be sampled');
                }
            } else {
                notes.push('no clip generated for this shot yet');
            }

            let card = {};
            try { card = JSON.parse(shot.scene_card_yaml || '{}') || {}; } catch (_) { card = {}; }

            return {
                shot_id: shot.id,
                shot_code: shot.shot_code,
                scene_number: shot.scene_number,
                card,
                showing_version: wanted || (frameRow ? frameRow.version : null),
                frame_count: images.length,
                notes,
                how_to_read:
                    'The first image is the board — what this shot is meant to be. Any that follow are '
                    + 'sampled from the generated clip in order. Compare composition, who is where, the '
                    + 'camera height and angle, and whether the action happens in the right order. Say '
                    + 'what MOVED and by roughly how much, not just a score: "MAYA is about 18% too far '
                    + 'left" is actionable and "composition 0.82" is not.',
                images,
            };
        },
    },
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
        description: 'Generate the reference plate for ONE subject. SPENDS CREDITS. Use this rather than plate_generate_all when some subjects already have a plate worth keeping \u2014 generating a plate DELETES the existing one for that subject, so a batch run replaces work you may want to keep. kind is character, location or prop. A location or prop can hold SEVERAL named views \u2014 pass `view` to generate one side without touching the others.',
        schema: {
            subject_id: { type: 'string' },
            kind: { type: 'string', description: 'character | location | prop' },
            views: { type: 'array', description: 'Characters only: which of front, side, back. Defaults to all three.' },
            view: { type: 'string', description: 'Locations and props only: ONE named side, e.g. "rear" or "three-quarter front" for a vehicle, or a compass side for a location. Omit for the subject\u2019s default plate. Each view is its own picture and its own row, so generating one never replaces another.' },
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
            /*
             * A PROP HAS SIDES TOO, and this tool could not ask for one.
             *
             * The route, `generatePlate` and `plateFileName` have all taken a
             * `view` for every kind since locations got their compass; only
             * this dispatcher never passed one, so a prop was stuck with a
             * single plate. A hero vehicle is the case that proves it: front,
             * rear and three-quarter are different objects to a model, and one
             * plate hands every shot the same side of the car.
             *
             * `views` (plural) stays what it was -- the character turnaround,
             * which generates several in one call. `view` (singular) is one
             * named side of a location or a prop.
             */
            const body = kind === 'character'
                ? (a.views ? { views: a.views } : {})
                : (a.view ? { view: String(a.view) } : {});
            return callRoute('POST', spec.path(a.subject_id), body, spec.handler);
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
    listTools, buildTools: listTools, hasTool, callTool, isFailure, presentResult,
    toolNameForNodeType, normalizeInputs, callRoute,
    NODE_TOOL_PREFIX, ROUTE_TOOLS, PRODUCTION_TOOLS, BATCH_TOOLS, ALL_ROUTE_TOOLS, SSE_EXCEPTION,
};
