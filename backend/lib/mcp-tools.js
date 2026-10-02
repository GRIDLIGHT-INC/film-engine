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
const { handleSetBuilds } = require('../routes/set-builds');
const { handlePrevisLibrary } = require('../routes/previs-library');
const { handleBackups } = require('../routes/backups');
const { handlePostProduction } = require('../routes/post-production');
const { handleAppSettings } = require('../routes/app-settings');
const { handleProjectStorage } = require('../routes/project-storage');
const { handleEdits } = require('../routes/edits');
const { handleMusicMidi } = require('../routes/music-midi');
const { handleInstruments } = require('../routes/instruments');
const { handleProviders } = require('../routes/providers');
const { handleContinuity } = require('../routes/continuity');
const { handleMarketing } = require('../routes/marketing');
const { handleWorlds } = require('../routes/worlds');
const { handleApprovals } = require('../routes/approvals');
const { handleRepair } = require('../routes/repair');
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
const { handleVoice } = require('../routes/voice');
const { handleSequences } = require('../routes/sequences');
const { handleProductionGraph } = require('../routes/production-graph');
const { handleAnnotations } = require('../routes/annotations');
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

        /*
         * THE QUERY STRING HAS TO ARRIVE.
         *
         * This shim built `parts` from the path and then handed every handler
         * an EMPTY query object, so a tool whose options travel in the URL got
         * defaults and said nothing: `run_plan?order=shot` planned model-major,
         * `sequence_plan?expand=inbetweens` planned without them,
         * `voice_catalogue?refresh=true` served the cache. Twelve tools build a
         * query string, and for all of them the control reached nothing — which
         * is worse than not offering it, because it gets relied on.
         */
        const query = {};
        const qs = urlPath.split('?')[1];
        if (qs) {
            for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
        }

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
            const returned = route(req, res, parts, query);
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
            use_captures: {
                type: 'boolean',
                description:
                    'Build from the captures already stored against this world\'s LOCATION — the '
                    + 'panorama or orbit clip a director actually shot of the place — instead of '
                    + 'images you send here. A LiDAR scan is deliberately NOT used: a GLB is already '
                    + 'geometry and belongs in the previs stage, not in a reconstruction. Anything '
                    + 'not used comes back in captures_excluded with a reason.',
            },
            is_pano: {
                description:
                    'Whether a SINGLE image is a 360 panorama. One of "auto", true or false — '
                    + 'the provider refuses anything else. World Labs call a panorama the most '
                    + 'accurate spatial representation, so say true when the image really is one; '
                    + 'say false to stop a wide frame being read as one. Omit for auto.',
            },
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
        name: 'world_import_glb',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/worlds/${a.world_id}/versions/import`,
        body: a => { const { world_id, ...rest } = a || {}; return rest; },
        description:
            'Make a scene built in Blender the next version of a world, so Previs can walk through it and '
            + 'frame shots inside it. FREE: nothing is generated. Export the scene from Blender as glTF '
            + 'Binary (.glb, no Draco or meshopt compression) into the project\'s own folder (for example '
            + '03 Previs) and pass file_path relative to that folder, or send the bytes as glb (base64). '
            + 'glTF is metres, so the version arrives calibrated. The previous version is kept, and shots '
            + 'pinned to it stay; pin a shot to the new version with world_pin_shot. An optional '
            + 'equirectangular panorama rendered in Blender gives the 360 view.',
        schema: {
            world_id: { type: 'string' },
            file_path: { type: 'string', description: 'The .glb, relative to the project folder (or absolute inside it).' },
            glb: { type: 'string', description: 'The .glb as base64, when it is not in the project folder.' },
            panorama_path: { type: 'string', description: 'Optional 2:1 equirectangular PNG inside the project folder.' },
            source: { type: 'string', description: 'blender (default) | glb' },
            reason: { type: 'string', description: 'What changed in this version of the set.' },
        }, required: ['world_id'],
    },
    {
        name: 'set_build_brief',
        handler: handleSetBuilds, method: 'GET',
        path: a => `/film/locations/${a.location_id}/set-build/brief?images=1`,
        description:
            'Everything needed to build a location\'s set in Blender from its own plates: the plates themselves '
            + '(as images), the location\'s description and orientation plan, the layout vocabulary, the '
            + 'conventions, whether Blender is installed, and the last attempt\'s layout to iterate from. FREE. '
            + 'YOU write the layout from it (the engine never guesses a room); then call set_build_render.',
        schema: { location_id: { type: 'string' } }, required: ['location_id'],
    },
    {
        name: 'set_build_render',
        handler: handleSetBuilds, method: 'POST',
        path: a => `/film/locations/${a.location_id}/set-builds`,
        body: a => ({ layout: a.layout, note: a.note, with_images: true }),
        description:
            'Build a layout headless in Blender and render it from every plate camera. FREE: Blender runs on '
            + 'this machine. Returns one sheet per plate (the plate, the render, and the two blended) as images, '
            + 'so you can SEE where the set is wrong. Fix the cameras first (position, yaw, pitch, lens), then '
            + 'the geometry, and render again; every attempt is kept. A refused layout names the field.',
        schema: {
            location_id: { type: 'string' },
            layout: { type: 'object', description: 'room, openings, objects, cameras: see set_build_brief.schema.' },
            note: { type: 'string', description: 'What changed in this attempt.' },
        }, required: ['location_id', 'layout'],
    },
    {
        name: 'set_build_list',
        handler: handleSetBuilds, method: 'GET',
        path: a => `/film/locations/${a.location_id}/set-builds`,
        description: 'Every set-build attempt for a location, newest first, with its status and comparison sheets. FREE.',
        schema: { location_id: { type: 'string' } }, required: ['location_id'],
    },
    {
        name: 'set_build_get',
        handler: handleSetBuilds, method: 'GET',
        path: a => `/film/set-builds/${a.build_id}`,
        description: 'One set-build attempt: its layout, status, comparison sheets and, once finished, its world version and 3D asset. FREE.',
        schema: { build_id: { type: 'string' } }, required: ['build_id'],
    },
    {
        name: 'set_build_finish',
        handler: handleSetBuilds, method: 'POST',
        path: a => `/film/set-builds/${a.build_id}/finish`,
        description:
            'Finish a rendered attempt: every surface is camera-projected from the plate that sees it, the set '
            + 'is exported as a GLB, made the next version of the location\'s world (the world is created if the '
            + 'location has none), and kept as a 3D model asset. FREE. Earlier versions stay, and no shot is '
            + 'moved: pin one with world_pin_shot to walk the set in Previs.',
        schema: { build_id: { type: 'string' } }, required: ['build_id'],
    },
    {
        name: 'set_build_for_version',
        handler: handleSetBuilds, method: 'GET',
        path: a => `/film/set-builds?world_version_id=${encodeURIComponent(a.world_version_id)}`,
        description: 'The set-build attempt a world version was made from, with its layout (walls, openings, floors, '
            + 'objects, cameras), or 404 when the version did not come from a set layout. FREE.',
        schema: { world_version_id: { type: 'string' } }, required: ['world_version_id'],
    },
    {
        name: 'set_build_edit',
        handler: handleSetBuilds, method: 'POST',
        path: a => `/film/set-builds/${a.build_id}/edit`,
        body: a => ({ objects: a.objects, note: a.note }),
        description: 'Rebuild a set with its OBJECTS changed (moved, turned, resized, added or removed) and everything '
            + 'else kept as the attempt it came from: walls, openings, floors, stairs, light and photo cameras. '
            + 'Built and finished in Blender, FREE, as the location\'s next world version; no shot is moved, so pin '
            + 'the shots with world_pin_shot. Pass the FULL objects list in the layout vocabulary (set_build_brief).',
        schema: { build_id: { type: 'string' }, objects: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } },
        required: ['build_id', 'objects'],
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
        name: 'camera_compare',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/direct/compare`,
        body: a => ({ a: a.a, b: a.b, a_name: a.a_name, b_name: a.b_name }),
        description:
            'Two cameras on the same axes, each computed the same way \u2014 lens, height, '
            + 'distance, tilt and occupancy. FREE: it reads two cameras and does arithmetic, and '
            + 'nothing is generated or written. '
            + 'Use it after camera_propose or camera_explore_accept to say which of two candidates '
            + 'is the shot, in numbers rather than by eye. Both sides may carry their own blocking '
            + 'and occupancy; a bare camera is accepted too, so two proposals can be compared '
            + 'without reconstructing anything.',
        schema: {
            shot_id: { type: 'string' },
            a: { type: 'object', description: 'The first camera, or { camera, blocking, occupancy }.' },
            b: { type: 'object', description: 'The second.' },
            a_name: { type: 'string', description: 'What to call the first column.' },
            b_name: { type: 'string', description: 'What to call the second.' },
        }, required: ['shot_id', 'a', 'b'],
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
        name: 'generation_plate',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/generation-plate`,
        body: a => { const { shot_id, ...rest } = a || {}; return rest; },
        description:
            'What a geometric plate for this shot would carry: the camera and blocking it renders '
            + 'from, the raster it renders at (the shot\'s own delivery shape, so a vertical shot is '
            + 'rendered vertical rather than cropped later), the three outputs — image, depth and '
            + 'subject masks — and the sentence that names it in the prompt. FREE: this is a local '
            + 'render, and it is the free step that precedes every paid generation. '
            + 'A plate leads the reference list: it fixes the camera, the framing and where each '
            + 'subject stands, and the image model supplies everything else. A plate whose world '
            + 'version has been deleted reports as DETACHED rather than stale, because you cannot '
            + 're-render against geometry that no longer exists.',
        schema: {
            shot_id: { type: 'string' },
            aspect: { type: 'string', description: 'Override the delivery shape, e.g. "9:16" for a vertical cut.' },
            move: { type: 'object', description: 'The camera move, so it can travel to video as prose: { movement, amountM, durationMs, rotate }' },
        }, required: ['shot_id'],
    },
    {
        name: 'approval_envelope',
        handler: handleApprovals, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/approval-envelope`
            + `?action=${encodeURIComponent(a.action || 'image')}`
            + (a.tier ? `&tier=${encodeURIComponent(a.tier)}` : ''),
        description:
            'Everything needed to decide whether to run this, as one packet. FREE, and nothing '
            + 'is generated. It is ASSEMBLED from the previews that already answer these '
            + 'questions rather than recomputing them, so it cannot disagree with what actually '
            + 'runs: the prompt that will really be sent with its ceiling and the tail that will '
            + 'not fit, which references are attached and in what role, the tier, model and '
            + 'provider, and the credit estimate. '
            + 'The `warnings` array is what turns a yes/no into an informed one — a stale input, '
            + 'a subject with no plate or no declared size, a provider nobody chose: none of that '
            + 'is visible in a picture and all of it changes the answer. '
            + 'Media travels as ABSOLUTE PATHS and the packet says so in media.transport, because '
            + 'a serving URL only resolves on the machine\'s own network. '
            + 'It carries a `fingerprint` of the inputs; hand that back as `approval_fingerprint` '
            + 'on the run and the engine re-derives it and REFUSES with 409 STALE_APPROVAL if '
            + 'anything changed in between — so "I approved that" and "that is what ran" cannot '
            + 'become different claims.',
        schema: {
            shot_id: { type: 'string' },
            action: { type: 'string', description: '"image" (default) or "video".' },
            tier: { type: 'string', description: 'For video: draft | production | hero, to price the tier you are considering.' },
        }, required: ['shot_id'],
    },
    {
        name: 'repair_plan',
        handler: handleApprovals, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/repair-plan`
            + `?start_sec=${encodeURIComponent(a.start_sec)}&end_sec=${encodeURIComponent(a.end_sec)}`
            + (a.resolution ? `&resolution=${encodeURIComponent(a.resolution)}` : '')
            + (a.bridge ? `&bridge=1&next_shot_id=${encodeURIComponent(a.next_shot_id || '')}`
                + `&next_end_sec=${encodeURIComponent(a.next_end_sec)}` : ''),
        description:
            'What redoing the section between two marks would do, and what it would cost. '
            + 'FREE and side-effect-free: nothing is extracted, generated or written, so raise it '
            + 'as often as you like and try three ranges before committing to one. '
            + 'The marks are CLIP-RELATIVE SECONDS — offsets into this shot\'s own footage, not '
            + 'positions in the finished film. '
            + 'It reports the two frames that would be extracted and at which timestamps, what '
            + 'would be generated and at what duration and raster, how the result goes back in, '
            + 'and the cost from the provider\'s own rate table. '
            + 'A range under the model\'s four-second floor is REFUSED with both remedies priced — '
            + 'widen the marks, which changes what you marked, or generate four seconds and trim '
            + 'back, which pays for footage nobody sees. Neither is chosen for you. '
            + 'The resolution follows the source clip unless you name one, because a repair '
            + 'generated at a different raster from the footage around it is a visible seam.',
        schema: {
            shot_id: { type: 'string' },
            start_sec: { type: 'number', description: 'Seconds into THIS shot\'s clip where the repair starts.' },
            end_sec: { type: 'number', description: 'Seconds into THIS shot\'s clip where it must arrive.' },
            resolution: { type: 'string', description: 'Optional: 480p | 720p | 1080p | 4k. Defaults to the source\'s own.' },
            bridge: { type: 'boolean', description:
                'Set when the fault is the TRANSITION between two shots rather than anything inside one. '
                + 'Then start_sec is the out-point in THIS shot, next_shot_id is the shot on the far side '
                + 'of the cut, and next_end_sec is the in-point in that one. The result is a BRIDGE — its '
                + 'own piece of footage plus two trim points — because when a cut reads wrong neither shot '
                + 'is individually at fault, so repairing either one cannot fix it.' },
            next_shot_id: { type: 'string', description: 'With bridge: the shot on the far side of the cut.' },
            next_end_sec: { type: 'number', description: 'With bridge: the in-point in that shot, in its own seconds.' },
        }, required: ['shot_id', 'start_sec', 'end_sec'],
    },
    {
        name: 'repair_run',
        handler: handleRepair, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/repair`,
        body: a => ({ start_sec: a.start_sec, end_sec: a.end_sec,
            ...(a.resolution ? { resolution: a.resolution } : {}),
            ...(a.bridge ? { bridge: true, next_shot_id: a.next_shot_id, end_sec: a.next_end_sec } : {}),
            ...(a.ignore_budget ? { ignore_budget: true } : {}) }),
        description:
            'SPENDS CREDITS — one generation for the marked range, priced by repair_plan. '
            + 'Run repair_plan first and read the cost; this does not ask again. '
            + 'It extracts the two frames, exposes them at a URL the provider can fetch, '
            + 'generates between them, splices head + new + tail back into one clip at the '
            + 'source\'s own frame rate, and registers the result as a NEW VERSION. '
            + 'THE PREVIOUS TAKE SURVIVES: a repair is an attempt, and the footage it improves '
            + 'was paid for, so nothing is overwritten. '
            + 'Every failure names the STAGE it happened at — plan, budget, extract, host, '
            + 'generate, splice or register — so "it failed" is never the whole answer. '
            + 'Over budget it refuses with 402 before anything is generated; pass ignore_budget '
            + 'to override that deliberately.',
        schema: {
            shot_id: { type: 'string' },
            start_sec: { type: 'number', description: 'Seconds into THIS shot\'s clip where the repair starts.' },
            end_sec: { type: 'number', description: 'Seconds into THIS shot\'s clip where it must arrive.' },
            resolution: { type: 'string', description: 'Optional: 480p | 720p | 1080p | 4k.' },
            ignore_budget: { type: 'boolean', description: 'Run even if the projected cost exceeds the project budget.' },
            bridge: { type: 'boolean', description:
                'SPENDS CREDITS. Bridge the cut between two shots rather than repairing inside one. '
                + 'The result is registered as a BRIDGE, not as shot footage, and NEITHER shot is '
                + 'rewritten — you get the new piece plus where to trim each of them. Run repair_plan '
                + 'with bridge first and read the cost.' },
            next_shot_id: { type: 'string', description: 'With bridge: the shot on the far side of the cut.' },
            next_end_sec: { type: 'number', description: 'With bridge: the in-point in that shot, in its own seconds.' },
        }, required: ['shot_id', 'start_sec', 'end_sec'],
    },
    {
        name: 'bridge_list',
        handler: handleRepair, method: 'GET',
        path: a => `/film/projects/${a.project_id}/bridges`,
        description:
            'Every bridge generated for this project, and where each one goes. FREE — this is a '
            + 'read and spends nothing. '
            + 'A bridge is what repair_run produces across a cut: a piece of footage that replaces '
            + 'the TAIL of one shot and the HEAD of the next. It is DELIBERATELY NOT in the '
            + 'timeline, the conform or any NLE export — a bridge that placed itself would be '
            + 'making the edit the editor opened Premiere to make — so this listing is the only '
            + 'way to find one. '
            + 'Each row carries the two shots it sits between, the trim point for each of them, '
            + 'its length and a servable URL. Without the trim points a bridge is a clip nobody '
            + 'knows where to put.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'take_candidates',
        handler: handleApprovals, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/take-candidates`
            + `?limit=${encodeURIComponent(a.limit || 6)}`
            + (a.proxy_max_bytes ? `&proxy_max_bytes=${encodeURIComponent(a.proxy_max_bytes)}` : ''),
        description:
            'Which archived attempt is the take. FREE. Every generation is already kept, and this '
            + 'hands them out newest-first with the thing that actually separates two '
            + 'near-identical frames: WHY each one exists — refined from which version, on what '
            + 'instruction, restored, sent from another shot, or generated. An attempt whose own '
            + 'picture was never archived is listed as not selectable WITH THE REASON rather than '
            + 'omitted, because it is real history. '
            + 'Pass `proxy_max_bytes` for video candidates and each gets a 720p proxy under that '
            + 'ceiling plus a still; a clip that cannot be brought under it returns no proxy and '
            + 'says why rather than handing back something oversized. '
            + 'Resolving goes back through the selection that already exists — POST '
            + '/film/versions/:version_id/select — never a second idea of what a take is.',
        schema: {
            shot_id: { type: 'string' },
            limit: { type: 'number', description: 'How many attempts to return, newest first. Default 6.' },
            proxy_max_bytes: { type: 'number', description:
                'Build a review proxy for video candidates under this many bytes. This engine has '
                + 'no opinion about any particular ceiling — name the one you are transferring into.' },
        }, required: ['shot_id'],
    },
    {
        name: 'match_reference',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/match-reference`,
        body: a => { const { shot_id, ...rest } = a || {}; return rest; },
        description:
            'Turn marks made on a reference frame — a Framed Ink panel, a storyboard, a movie '
            + 'still — into a camera. FREE. THIS IS MANUAL-ASSIST AND SEES NO IMAGE: it takes only '
            + 'the marks, so nothing here detects a horizon, a subject or a vanishing point, and it '
            + 'claims none. Every estimate it cannot make is returned NULL with the marks that were '
            + 'missing, and the confidence is derived from what you actually marked rather than '
            + 'asserted — an approximation, never a reconstruction of the original camera. '
            + 'The horizon alone gives roll exactly; add a subject box and that subject\'s real '
            + 'height and it gives camera height, because the horizon crosses a standing figure at '
            + 'the camera\'s own eye level. Applying is separate and goes through the same '
            + 'validator every camera goes through: it writes CAMERA fields only, never the '
            + 'blocking, the subjects or the world.',
        schema: {
            shot_id: { type: 'string' },
            marks: { type: 'object', description:
                'What you marked, in fractions of the frame (0..1, y down): '
                + '{ horizon: {a:[x,y], b:[x,y]}, subject_box: {x,y,w,h}, subject_height_m: number, '
                + 'vanishing_lines: [{a:[x,y], b:[x,y]}, ...], focal_mm: number }' },
            sensor: { type: 'object', description: 'Optional { widthMm, heightMm }. Defaults to Super 35.' },
            pin_occupancy: { type: 'boolean', description: 'Also carry the subject occupancy across as a framing target.' },
            apply: { type: 'boolean', description: 'Write the camera onto the shot. Default false — solve, read the confidence, then apply.' },
            strict: { type: 'boolean', description: 'Refuse a line crossing as well.' },
        }, required: ['shot_id'],
    },
    {
        name: 'shot_complexity',
        handler: handleWorlds, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/complexity`,
        body: a => ({ inputs: a.inputs || {} }),
        description:
            'How likely is this shot to come back wrong, BEFORE anything is generated. FREE. '
            + 'Returns LOW, MEDIUM or HIGH over seven inputs, with each input\'s contribution, so '
            + 'the grade can be argued with. HIGH carries a split suggestion naming what to cut on '
            + '— the remedy for a crowded shot is to split it, which no amount of prompt wording '
            + 'achieves. Three inputs are DERIVED from what the engine holds (subjects, camera '
            + 'movement, duration) and four are marked `ask` in derived_from because they are '
            + 'readings rather than counts: which subjects move, contact with the set, occlusion, '
            + 'and how many distinct actions the shot contains. Supply those — you have read the '
            + 'scene; the engine has not.',
        schema: {
            shot_id: { type: 'string' },
            inputs: { type: 'object', description:
                'Any of: subjects, moving_subjects, camera_movement, environment_interactions, '
                + 'occlusion (0..1), duration_s, distinct_actions. Anything omitted uses the '
                + 'derived value.' },
        }, required: ['shot_id'],
    },
    {
        name: 'world_export',
        handler: handleWorlds, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/world-export`,
        description:
            'The manifest for handing this shot\'s geometry to somebody else. FREE, and it is a '
            + 'manifest rather than the bytes: whether each output exists is the question to answer '
            + 'before packaging 25 MB of splat. Seven outputs — camera JSON, world metadata JSON, '
            + 'the collider GLB, the splat as a URL rather than a file, the generation plate, the '
            + 'depth pass, and the shot thumbnail. EVERY ONE NAMES THE WORLD VERSION IT CAME FROM, '
            + 'because a camera JSON without it is a set of numbers in an unnamed space. An output '
            + 'that does not exist yet is named with the reason rather than omitted.',
        schema: { shot_id: { type: 'string' } }, required: ['shot_id'],
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
        name: 'model_catalog',
        handler: require('../routes/model-catalog').handleModelCatalog, method: 'GET',
        path: () => '/film/model-catalog',
        description:
            'The self-hosted model catalog (FEM-001): every model gridlight can run, with its '
            + 'capabilities, licence and commercial-use state, allowed AWS regions, consent '
            + 'requirements, cost and limits. FREE. It is authored in gridlight and vendored here; '
            + 'a field is null only when `unknown` says why. Whether a model may actually run is '
            + 'decided fail-closed: a region its licence excludes (MiniMax H3 runs only in '
            + 'ca-central-1), an expired licence, a production run on a model not permitted '
            + 'commercially, or a cloned voice or likeness without consent is refused.',
        schema: {}, required: [],
    },
    {
        name: 'model_controls',
        handler: require('../routes/model-catalog').handleModelCatalog, method: 'GET',
        path: a => `/film/model-catalog/${encodeURIComponent(a.model_id)}/controls`,
        description: 'One catalog model\u2019s control schema (JSON schema), durations and output formats, '
            + 'as the Production client reads them. FREE.',
        schema: { model_id: { type: 'string', description: 'The catalog id, e.g. minimax-h3.' } },
        required: ['model_id'],
    },
    {
        name: 'model_catalog_audit',
        handler: require('../routes/model-catalog').handleModelCatalog, method: 'GET',
        path: () => '/film/model-catalog/audit',
        description: 'Every recorded change to the model catalog, newest first: the version it moved '
            + 'from and to, and each model field that changed. FREE.',
        schema: {}, required: [],
    },
    {
        name: 'model_licence_grants',
        handler: require('../routes/model-catalog').handleModelCatalog, method: 'GET',
        path: () => '/film/model-catalog/grants',
        description: 'Every licence grant this organisation has recorded for a self-hosted model, '
            + 'revoked ones included. FREE. A catalog model whose public licence is not "permitted" '
            + 'for commercial use can be enabled for production only while a grant for it is in force.',
        schema: {}, required: [],
    },
    {
        name: 'model_licence_grant',
        handler: require('../routes/model-catalog').handleModelCatalog, method: 'POST',
        path: () => '/film/model-catalog/grants',
        description: 'Record the organisation\u2019s own licence for a catalog model (a paid FLUX licence, '
            + 'a Fish commercial agreement, Stability Enterprise). This is a statement of fact about a '
            + 'contract: record only a licence the user has told you they hold, with their name as '
            + 'granted_by. It enables production for that model until it expires or is revoked. FREE.',
        schema: {
            model_id: { type: 'string', description: 'Catalog id, repository or alias, e.g. flux2-dev.' },
            licence_ref: { type: 'string', description: 'The contract, order or licence number.' },
            scope: { type: 'string', description: 'What it covers, in the licence\u2019s words.' },
            granted_by: { type: 'string', description: 'Who is recording it — the person, not the agent.' },
            granted_on: { type: 'string', description: 'YYYY-MM-DD; defaults to today.' },
            expires_at: { type: 'string', description: 'YYYY-MM-DD, or omit for no expiry.' },
        },
        body: a => ({ model_id: a.model_id, licence_ref: a.licence_ref, scope: a.scope, granted_by: a.granted_by, granted_on: a.granted_on, expires_at: a.expires_at }),
        required: ['model_id', 'licence_ref', 'granted_by'],
    },
    {
        name: 'model_licence_revoke',
        handler: require('../routes/model-catalog').handleModelCatalog, method: 'POST',
        path: a => `/film/model-catalog/grants/${encodeURIComponent(a.grant_id)}/revoke`,
        description: 'Revoke a licence grant. The record stays, marked revoked; production for that model '
            + 'stops being enabled by it. FREE.',
        schema: { grant_id: { type: 'number' }, revoked_by: { type: 'string', description: 'Who revoked it.' } },
        body: a => ({ revoked_by: a && a.revoked_by }),
        required: ['grant_id', 'revoked_by'],
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
    /*
     * THE PRODUCTION GRAPH (PGN-021). Every action the graph's page offers,
     * dispatched through its own route — tests/graph-mcp-tools.test.js derives
     * the set from routes/production-graph.js, so a route added later arrives
     * with a tool or a stated reason.
     */
    {
        name: 'production_graph_get',
        handler: handleProductionGraph, method: 'GET',
        path: a => `/film/projects/${a.project_id}/production-graph`,
        description: 'The Production phase as one graph: every shot, sequence, sound and version as a node with its key '
            + '(shot:<id>, seq:<id>, sound:<id>, ver:<id>), what each is built from, whether it is behind (impact), held, or running, '
            + 'and what "Run pending" would make. FREE. Read this first: the other graph tools take these node keys.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'production_graph_running',
        handler: handleProductionGraph, method: 'GET',
        path: a => `/film/projects/${a.project_id}/production-graph/running`,
        description: 'What is generating right now and on which node, with its percentage or phase where the provider reports one. FREE.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'generation_queue',
        handler: handleProductionGraph, method: 'GET',
        path: a => `/film/projects/${a.project_id}/production-graph/queue`,
        description: 'The queue in one read: running, waiting in a batch, done today, awaiting collection, and failed — each job in '
            + 'exactly one bucket, with its node and, while running, whether it can really be cancelled. FREE.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'run_changed_plan',
        handler: handleProductionGraph, method: 'GET',
        path: a => `/film/projects/${a.project_id}/production-graph/run-changed/plan`,
        description: '"Run what changed", planned for FREE: every out-of-date item that can be redone now, in dependency order, '
            + 'each priced, the total, the budget verdict, and everything left out with why (waiting on something above it, a '
            + 'card a person must rewrite, a locked board, a held node). Read this before run_changed.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'run_changed',
        handler: handleProductionGraph, method: 'POST',
        path: a => `/film/projects/${a.project_id}/production-graph/run-changed`,
        body: a => (a && a.ignore_budget ? { ignore_budget: true } : {}),
        description: 'COSTS MONEY: redoes everything run_changed_plan lists, one item at a time in the background, re-planning after '
            + 'each, stopping at the first refusal and naming what it did not attempt. Refused (402) over budget unless ignore_budget. '
            + 'Answers at once with a run id; follow it with run_changed_status. Held nodes are skipped.',
        schema: { project_id: { type: 'string' }, ignore_budget: { type: 'boolean' } }, required: ['project_id'],
    },
    {
        name: 'run_changed_status',
        handler: handleProductionGraph, method: 'GET',
        path: a => `/film/projects/${a.project_id}/production-graph/run-changed/${a.run_id}`,
        description: 'Where a "Run what changed" or "Run to here" run has got to: done, failed, still to come, and why it stopped. FREE.',
        schema: { project_id: { type: 'string' }, run_id: { type: 'string' } }, required: ['project_id', 'run_id'],
    },
    {
        name: 'run_to_here_plan',
        handler: handleProductionGraph, method: 'GET',
        path: a => `/film/projects/${a.project_id}/production-graph/nodes/${encodeURIComponent(a.node_key)}/run-to-here/plan`,
        description: '"Run to here", planned for FREE: what a shot, clip, sequence or sound still needs, frames before clips, borrowed '
            + 'frames traced, each step priced, blockers named, held nodes listed apart. node_key comes from production_graph_get.',
        schema: { project_id: { type: 'string' }, node_key: { type: 'string' } }, required: ['project_id', 'node_key'],
    },
    {
        name: 'run_to_here',
        handler: handleProductionGraph, method: 'POST',
        path: a => `/film/projects/${a.project_id}/production-graph/nodes/${encodeURIComponent(a.node_key)}/run-to-here`,
        body: a => (a && a.ignore_budget ? { ignore_budget: true } : {}),
        description: 'COSTS MONEY: makes everything run_to_here_plan lists, in order, through each step’s own generate path, in the '
            + 'background. Refused when something upstream blocks it (409) or over budget (402). Follow it with run_changed_status.',
        schema: { project_id: { type: 'string' }, node_key: { type: 'string' }, ignore_budget: { type: 'boolean' } },
        required: ['project_id', 'node_key'],
    },
    {
        name: 'run_cancel',
        handler: handleProductionGraph, method: 'POST',
        path: a => `/film/projects/${a.project_id}/production-graph/runs/${a.run_id}/cancel`,
        description: 'Stop a "Run what changed" / "Run to here" batch before its next step. FREE. A step already at a provider '
            + 'finishes (and bills); only what has not started is left undone, and the run names it.',
        schema: { project_id: { type: 'string' }, run_id: { type: 'string' } }, required: ['project_id', 'run_id'],
    },
    {
        name: 'generation_cancel',
        handler: handleGenerationJobs, method: 'POST',
        path: a => `/film/generation-jobs/${a.job_id}/cancel`,
        description: 'Cancel one running generation. FREE. Where the provider really cancels (Runway) it is cancelled there; '
            + 'everywhere else Film Engine STOPS WAITING and says the provider may still finish and bill — the job stays '
            + 'collectable with generation_collect. A synchronous call has nothing to cancel and says so.',
        schema: { job_id: { type: 'string' } }, required: ['job_id'],
    },
    {
        name: 'asset_provenance',
        handler: handleAssets, method: 'GET',
        path: a => `/film/assets/${a.asset_id}/provenance`,
        description: 'How one version was made: provider, model, prompt, negative prompt, references, seed (and whether the '
            + 'provider honours one), size, tier, whether its inputs are still current, the render-ledger row, what it cost, and '
            + 'when — every fact it cannot find named as unknown. Plus the disclosure manifest. FREE.',
        schema: { asset_id: { type: 'string' } }, required: ['asset_id'],
    },
    {
        name: 'pattern_list',
        handler: handleProductionGraph, method: 'GET',
        path: a => `/film/projects/${a.project_id}/production-graph/patterns`,
        description: 'The coverage patterns (shot / reverse shot, insert then reaction, wide / medium / close): the shots and joins each lays down. FREE.',
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'pattern_preview',
        handler: handleProductionGraph, method: 'GET',
        path: a => `/film/projects/${a.project_id}/production-graph/patterns/${encodeURIComponent(a.pattern)}/preview?after=${encodeURIComponent(a.after_shot_id)}`,
        description: 'What a pattern would create after a shot, for FREE: the shots with the insert codes they will get (2AA, 2AB…), '
            + 'their framing and role, the cast carried over, and the sequence with its joins. Writes nothing.',
        schema: { project_id: { type: 'string' }, pattern: { type: 'string' }, after_shot_id: { type: 'string' } },
        required: ['project_id', 'pattern', 'after_shot_id'],
    },
    {
        name: 'pattern_create',
        handler: handleProductionGraph, method: 'POST',
        path: a => `/film/projects/${a.project_id}/production-graph/patterns/${encodeURIComponent(a.pattern)}`,
        body: a => ({ after_shot_id: a.after_shot_id }),
        description: 'Create a pattern after a shot: its shots, inserted after it as a script supervisor numbers inserts, and one '
            + 'sequence of them with its joins. Nothing is generated — FREE; make their frames and clips afterwards.',
        schema: { project_id: { type: 'string' }, pattern: { type: 'string' }, after_shot_id: { type: 'string' } },
        required: ['project_id', 'pattern', 'after_shot_id'],
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
        name: 'world_capture_upload',
        handler: handleLocations, method: 'POST',
        path: a => `/film/locations/${a.location_id}/capture/import`,
        body: a => ({ data: a.capture, name: a.name }),
        description:
            'Attach a CAPTURE of a real location \u2014 the environment itself, shot rather than '
            + 'imagined. FREE \u2014 nothing is generated. One target takes all three media a '
            + 'capture arrives as, and WHICH ONE IS DECIDED FROM THE BYTES, not the filename: a '
            + '360 panorama (PNG or JPEG \u2014 World Labs call a panorama the most accurate '
            + 'spatial representation), a short orbit clip (MP4 or MOV), or a LiDAR scan (GLB). '
            + 'This is what a world is reconstructed FROM, and it is deliberately not a plate: a '
            + 'plate is one picture this engine generated, a capture is evidence of somewhere '
            + 'that exists. Use plate_upload for a reference picture instead. The response '
            + 'reports capture_kind so you know which medium was recognised.',
        schema: {
            location_id: { type: 'string', description: 'The location this capture is of.' },
            capture: {
                type: 'string',
                description: 'A data URI: image/png, image/jpeg, video/mp4, video/quicktime, or model/gltf-binary.',
            },
            name: { type: 'string', description: 'What to call it on disk. Optional.' },
        },
        required: ['location_id', 'capture'],
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
            + ((q => (q ? `?${q}` : ''))(['tier', 'video', 'video_model', 'use_dialogue_audio', 'options']
                .filter(k => a[k]).map(k => `${k}=${encodeURIComponent(k === 'options' && typeof a[k] === 'object'
                    ? JSON.stringify(a[k]) : a[k])}`).join('&'))),
        description: 'What a clip for this shot would be asked for, and what it would COST \u2014 free, and nothing is generated. Reports the model, the length, whether the storyboard frame is attached, the reference package the model would receive, and an itemised credit estimate including reference charges and any minimum. Pass `tier` (draft | production | hero) to price the tier you are considering: a draft is 25 credits for five seconds, the cheap way to check blocking before buying the real shot. SPENDS NOTHING.',
        schema: { shot_id: { type: 'string' },
            tier: { type: 'string', enum: ['draft', 'production', 'hero'], description: 'Price and plan this tier. draft = Gen-4 Turbo, 5s, 25 credits — the blocking check. production = H3 768P with the reference package. hero = your choice.' },
            video: { type: 'string', description: 'Preview a different provider for this one clip — the same override video_generate takes.' },
            video_model: { type: 'string', description: 'Preview a different model for this one clip.' },
            use_dialogue_audio: { type: 'boolean', description: 'Preview sending the shot\'s recorded dialogue as an audio reference (Seedance 2.5 on MuAPI, or seedance2_5 on Runway). The preview says how many lines would go, or why none can.' },
            options: { type: 'object', description: 'The model\'s own options for this one clip, as an object: duration (seconds, or \'auto\' where the model takes it), ratio, resolution, audio (true/false), last_frame (the id of another shot in this project whose board frame the clip ends on), output_format (Gen-4.5: mp4, prores, hdr10, hlg...), negative_prompt, seed, draft (MuAPI). Which of these a model takes, and their allowed values, is in video_preview\'s `options.controls`, read from the provider\'s own schema; a value outside it is refused by name and nothing is sent. Unset means as the project would have it. Returned as `options`: the controls this model takes, what is chosen, and the shots whose frame it could end on.' } },
        required: ['shot_id'],
    },
    {
        name: 'video_generate',
        handler: handleVideoGen, method: 'POST',
        description:
            'Generate the CLIP for one shot, from its existing keyframe. SPENDS MONEY. Read '
            + 'video_preview first \u2014 it is free and reports the exact prompt, the model, the '
            + 'length, the reference package and the dollars this will cost. A clip routinely takes '
            + 'longer than the 60s a tool call is given, so an abandoned call is normal: the job is '
            + 'accepted and paid for, and generation_collect delivers it from the handle. Never '
            + 'generate the same shot twice to recover one \u2014 check generation_pending first.',
        path: a => `/film/shots/${a.shot_id}/video/generate`,
        schema: {
            shot_id: { type: 'string' },
            video: { type: 'string', description: 'Override the provider for this one clip.' },
            video_model: { type: 'string', description: 'Override the model for this one clip.' },
            use_dialogue_audio: { type: 'boolean', description: 'Send the shot\'s recorded dialogue (its voice files, uploaded with media_upload or generated) as an audio reference, so the performance follows your recording. Seedance 2.5 only: on MuAPI it runs the omni-reference workflow, where the storyboard frame becomes a reference rather than the exact first frame; on Runway use video_model seedance2_5.' },
            options: { type: 'object', description: 'The model\'s own options for this one clip, as an object: duration (seconds, or \'auto\' where the model takes it), ratio, resolution, audio (true/false), last_frame (the id of another shot in this project whose board frame the clip ends on), output_format (Gen-4.5: mp4, prores, hdr10, hlg...), negative_prompt, seed, draft (MuAPI). Which of these a model takes, and their allowed values, is in video_preview\'s `options.controls`, read from the provider\'s own schema; a value outside it is refused by name and nothing is sent. Unset means as the project would have it.' },
        },
        required: ['shot_id'],
        bodyKeys: ['video', 'video_model', 'use_dialogue_audio', 'options'],
        probe: { shot_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        /*
         * The shot's DIALOGUE, as the take the film uses. The route shipped in
         * phase 4 and was reachable from the page and from curl only; an agent
         * had node_gen_voice, which stores nothing when run alone, so a
         * screenplay could be taken to a final movie over MCP in every stage
         * except the one where the characters speak.
         */
        name: 'voice_generate',
        handler: handleVoice, method: 'POST',
        description:
            'Generate the dialogue for one shot: one audio file per line of its scene card, in each '
            + 'character\'s cast voice (voice_cast first, or the provider default is used). SPENDS '
            + 'MONEY. An unchanged line is REUSED rather than bought again — pass regenerate: true '
            + 'for a new take of every line. The files are the shot\'s dialogue: playback, the audio '
            + 'lanes of an NLE export and the conform read them.',
        path: a => `/film/shots/${a.shot_id}/voice/generate`,
        schema: {
            shot_id: { type: 'string' },
            regenerate: { type: 'boolean', description: 'Buy a new take of every line, including unchanged ones.' },
        },
        required: ['shot_id'],
        bodyKeys: ['regenerate'],
        probe: { shot_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'video_background_preview',
        handler: handleVideoGen, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/video/background/preview`
            + (a.instruction ? `?instruction=${encodeURIComponent(a.instruction)}` : ''),
        description:
            'What replacing this shot\u2019s background would send, and what it would COST. FREE and '
            + 'side-effect-free \u2014 nothing is exposed, generated or written, so try three '
            + 'backgrounds before buying one. '
            + 'It reports the assembled prompt, the model, the measured length of the source clip '
            + 'and the credit estimate. '
            + 'THE PRICE IS THE LENGTH OF THE CLIP HANDED IN, not the length of anything asked for: '
            + 'this model bills the source, so a 20-second take costs twice a 10-second one for the '
            + 'same edit. A clip nobody can measure is REFUSED rather than priced at a guess. '
            + 'SPENDS NOTHING.',
        schema: {
            shot_id: { type: 'string' },
            instruction: { type: 'string', description:
                'What the new background should be. Describe ONLY the background \u2014 the people, '
                + 'their positions and the camera are preserved by the model, and describing them '
                + 'again is what makes it re-render them.' },
        }, required: ['shot_id'],
    },
    {
        name: 'video_background_replace',
        handler: handleVideoGen, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/video/background/generate`,
        body: a => ({ instruction: a.instruction,
            ...(a.ignore_budget ? { ignore_budget: true } : {}) }),
        description:
            'SPENDS CREDITS \u2014 keep the performance in this shot\u2019s footage and put it '
            + 'somewhere else. Run video_background_preview first and read the cost; this does not '
            + 'ask again. '
            + 'The actor is preserved BY THE MODEL rather than by a matte, so describe only what '
            + 'changes: naming the people pulls the result toward a fresh generation of them. '
            + 'It measures the source, exposes it at a URL the provider can fetch, generates the '
            + 'edit and registers the result as a NEW VERSION. THE PREVIOUS TAKE SURVIVES \u2014 '
            + 'the footage being edited was paid for and nothing is overwritten. '
            + 'Every failure names the STAGE it happened at \u2014 plan, budget, host, generate or '
            + 'register \u2014 so "it failed" is never the whole answer. '
            + 'A source outside the model\u2019s 2\u201330 second window is refused before anything '
            + 'is sent, with trimming named as the way through. Over budget it refuses with 402 '
            + 'before generating; pass ignore_budget to override that deliberately.',
        schema: {
            shot_id: { type: 'string' },
            instruction: { type: 'string', description:
                'The new background. Describe the PLACE and nothing else \u2014 not the people, not '
                + 'their wardrobe, not the camera.' },
            ignore_budget: { type: 'boolean', description: 'Generate even if the projected cost exceeds the project budget.' },
        }, required: ['shot_id', 'instruction'],
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
            if (a.held !== undefined) out.held = a.held;
            return out;
        },
        description: 'Change a sequence\u2019s shots, order or description, or hold it. Merged, not replaced, so renaming does not drop the description. Free.',
        schema: {
            sequence_id: { type: 'string' },
            held: { type: 'boolean', description: 'true HOLDS this node: every batch run skips it and says so, while the film keeps it (conform and export ignore a hold). false releases it. Free.' },
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
            assets_dir: {
                type: 'string',
                description: 'The folder this film\'s files are saved in — every plate, frame, clip and '
                    + 'sound, laid out in the order the film is made (01 References … 06 Delivery). '
                    + 'A full path, e.g. "~/Films/The Glass Harbour"; it must be new or empty. Omit it '
                    + 'and a folder named after the film is made inside ~/Film Engine (or the '
                    + 'projects_root setting). ASK the person where they want it before creating — '
                    + 'storage_suggest shows what the default would be, for free.',
            },
            assets_parent: {
                type: 'string',
                description: 'Instead of assets_dir: a folder to make this film\'s own folder INSIDE, '
                    + 'named after the title, e.g. "~/Films".',
            },
            video_draft: {
                type: 'boolean',
                description: 'Generate footage at the model\'s cheapest documented tier instead of '
                    + 'the delivery raster. OFF by default: every clip is asked at the delivery size, and '
                    + 'a generator that cannot reach it gives its best. Turn it on while blocking: on '
                    + 'Seedance a draft second is $0.17 against $0.85 at 1080p. Video only — the board is unaffected.',
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
        name: 'edit_list',
        handler: handleEdits, method: 'GET',
        description: 'The cuts of this film made in an editor (Premiere), every version, newest first: length, '
            + 'frame rate, whether the XML/EDL it was cut from is imported and how many of its events are '
            + 'Film Engine shots, and which score sessions are written against each. Free.',
        path: a => `/film/projects/${a.project_id}/edits`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'edit_get',
        handler: handleEdits, method: 'GET',
        description: 'One edit version with its full cut list: every event in the edit\'s own time, the Film '
            + 'Engine shot it is (matched by the clip file, else by shot code in its name) or that it is '
            + 'none (a title, a stock shot), plus overlays on higher tracks. Free.',
        path: a => `/film/edits/${a.edit_id}`,
        schema: { edit_id: { type: 'string' } }, required: ['edit_id'],
    },
    {
        name: 'edit_import',
        handler: handleEdits, method: 'POST',
        description: 'Bring a cut finished in Premiere back into the project as the NEXT edit version (nothing '
            + 'is overwritten). Send the exported picture as a data URI, or — for anything large — the id of '
            + 'a finished resumable upload (upload_id). Optionally send the Final Cut Pro XML or EDL it was '
            + 'cut from as `cut` in the same call. Stored in the project\'s "05 Edit" folder. Spends nothing.',
        path: a => `/film/projects/${a.project_id}/edits/import`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: {
            project_id: { type: 'string' },
            data: { type: 'string', description: 'data:video/mp4;base64,… or data:video/quicktime;base64,…' },
            upload_id: { type: 'string', description: 'A finished resumable upload (POST /film/uploads), for files too big for a data URI.' },
            name: { type: 'string', description: 'What to call this version, e.g. "Director\'s cut".' },
            notes: { type: 'string' },
            cut: { type: 'string', description: 'The Final Cut Pro XML (xmeml) or CMX 3600 EDL text the edit was exported with.' },
            sequence: { type: 'string', description: 'Which sequence in the XML, when it has several. Default: the one with the most picture.' },
        },
        required: ['project_id'],
    },
    {
        name: 'edit_cut_import',
        handler: handleEdits, method: 'POST',
        description: 'Attach (or replace) the cut an edit version was made from: Premiere\'s File → Export → '
            + 'Final Cut Pro XML, or an EDL. Read into a cut list saying which Film Engine shot plays where '
            + 'in the edit; unmatched events (titles, stock) are kept and named. FCPXML is refused by name. '
            + 'Spends nothing.',
        path: a => `/film/edits/${a.edit_id}/cut`,
        body: a => { const { edit_id, ...rest } = a || {}; return rest; },
        schema: {
            edit_id: { type: 'string' },
            text: { type: 'string', description: 'The XML or EDL text.' },
            sequence: { type: 'string', description: 'Which sequence in the XML, when it has several.' },
        },
        required: ['edit_id', 'text'],
    },
    {
        name: 'edit_cut_rematch',
        handler: handleEdits, method: 'POST',
        description: 'Match an edit\'s stored cut against the shots as they are NOW — after adding shots or '
            + 'uploading clips the edit uses. Free.',
        path: a => `/film/edits/${a.edit_id}/cut/rematch`,
        schema: { edit_id: { type: 'string' } }, required: ['edit_id'],
    },
    {
        name: 'edit_update',
        handler: handleEdits, method: 'PUT',
        description: 'Rename an edit version or change its notes.',
        path: a => `/film/edits/${a.edit_id}`,
        body: a => { const { edit_id, ...rest } = a || {}; return rest; },
        schema: { edit_id: { type: 'string' }, name: { type: 'string' }, notes: { type: 'string' } },
        required: ['edit_id'],
    },
    {
        name: 'edit_delete',
        handler: handleEdits, method: 'DELETE',
        description: 'Remove an edit version. REFUSED while a score session is written against it (the '
            + 'score would be timed to nothing); `force` removes it anyway and leaves those sessions with no '
            + 'picture. The files move to "05 Edit/deleted", recoverable.',
        path: a => `/film/edits/${a.edit_id}${a.force ? '?force=true' : ''}`,
        schema: { edit_id: { type: 'string' }, force: { type: 'boolean' } },
        required: ['edit_id'],
    },
    {
        name: 'project_storage_get',
        handler: handleProjectStorage, method: 'GET',
        description: 'Where a project\'s files are saved: its folder, whether it is in a project folder '
            + 'or the old layout (spread across Film Engine\'s data folder by kind), and every '
            + 'sub-folder with its file count and size. Free; reads only.',
        path: a => `/film/projects/${a.project_id}/storage`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'project_storage_move',
        handler: handleProjectStorage, method: 'POST',
        description: 'MOVE a project\'s files to a new folder and repoint every record at them — also '
            + 'how a project in the old layout gets a structured folder. The destination must be new '
            + 'or empty. Files move first and are counted before any record changes; if anything '
            + 'fails, everything is put back. Nothing is regenerated and nothing is spent, but it '
            + 'changes where the person finds their work: confirm the destination with them first.',
        path: a => `/film/projects/${a.project_id}/storage/move`,
        body: a => {
            const { project_id, ...rest } = a || {};
            return rest;
        },
        schema: {
            project_id: { type: 'string' },
            assets_dir: { type: 'string', description: 'The exact new folder, e.g. "~/Films/The Glass Harbour".' },
            parent: { type: 'string', description: 'Or: a folder to make the project\'s own folder inside, named after the title.' },
        },
        required: ['project_id'],
    },
    {
        name: 'storage_suggest',
        handler: handleProjectStorage, method: 'GET',
        description: 'The folder a project titled `title` would be saved in — inside `parent`, or the '
            + 'default projects folder — and whether it can be used. Free; creates nothing. Use it to '
            + 'offer a location before project_create or project_storage_move.',
        path: a => `/film/storage/suggest?title=${encodeURIComponent(a.title || '')}`
            + (a.parent ? `&parent=${encodeURIComponent(a.parent)}` : '')
            + (a.project_id ? `&project_id=${encodeURIComponent(a.project_id)}` : ''),
        schema: {
            title: { type: 'string' },
            parent: { type: 'string', description: 'The folder to make it inside. Omit for the default.' },
            project_id: { type: 'string', description: 'When suggesting a move: the project being moved, so its own folder is not counted as taken.' },
        },
        required: ['title'],
    },
    {
        name: 'storage_layout',
        handler: handleProjectStorage, method: 'GET',
        description: 'What a project folder looks like — every sub-folder and what goes in it — and '
            + 'where new projects are saved by default. Free.',
        path: () => '/film/storage/layout',
        schema: {}, required: [],
    },
    {
        name: 'storage_browse',
        handler: handleProjectStorage, method: 'GET',
        description: 'The folders inside a folder (in the home folder or on a mounted drive), for '
            + 'choosing where to save a project. Free; reads names only.',
        path: a => `/film/storage/browse${a.path ? `?path=${encodeURIComponent(a.path)}` : ''}`,
        schema: { path: { type: 'string', description: 'Folder to list. Omit for the home folder.' } },
        required: [],
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
            video_draft: { type: 'boolean', description: 'Draft video: clips at the model\'s cheapest size, upscaled at the end. Off by default, so every clip is asked at the delivery size.' },
            delivery_codec: { type: 'string', description: 'The delivery master\'s codec: h264, h265, prores_422_proxy, prores_422_lt, prores_422, prores_422_hq, prores_4444, dnxhr_hq or jpeg2000. Anything other than h264 (or audio other than stereo) makes the conform write a delivery master beside the H.264 one.' },
            delivery_audio_channels: { type: 'number', description: 'The delivery master\'s audio channels: 2 stereo, 6 for 5.1, 8 for 7.1, 12 for 12.0.' },
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
        name: 'previs_stage',
        handler: handlePrevis, method: 'PUT',
        path: a => `/film/shots/${a.shot_id}/previs/subjects`,
        body: a => ({ subjects: a.subjects }),
        description:
            'Place, move, turn or remove the people, furniture and models staged in a shot, and nothing else: the '
            + 'camera, its keys and the director\'s notes are kept. FREE. Each subject: { kind: human|mesh|cube|sphere|'
            + 'imageplane, name, position: [x, y, z] (y up, metres in a calibrated world), rotationDeg: [0, yaw, 0] '
            + '(0 faces north, -Z), sizeM: [width, height, depth], model: { library } or { asset_id }, path? }. A subject '
            + 'that MOVES carries path: [{ t (ms into the shot, in order, at most 200), position: [x, y, z], rotationDeg? }]; '
            + 'between keys she faces the way she travels unless both keys are turned, and she is stored where she starts. '
            + 'Send the WHOLE list: what is left out is removed. Only NAMED subjects reach a prompt.',
        schema: {
            shot_id: { type: 'string' },
            subjects: { type: 'array', description: 'The complete list of staged subjects.' },
        }, required: ['shot_id', 'subjects'],
    },
    {
        name: 'previs_director',
        handler: handlePrevis, method: 'PUT',
        path: a => `/film/shots/${a.shot_id}/previs/director`,
        body: a => {
            const b = {};
            for (const k of ['direction', 'lighting', 'location_view', 'camera_note']) if (a[k] !== undefined) b[k] = a[k];
            return b;
        },
        description:
            'Stage a shot\'s direction, LIGHTING, location view or camera note in Previs, field by field (null clears one). '
            + 'FREE, and staged: previs_apply writes it to the scene card, which is what generation reads. lighting is '
            + '{ technique, type (mood), key_side: left|right, notes }; techniques and moods are in card_vocabulary. '
            + 'A shot with no lighting of its own takes its location\'s; the film\'s general look is the style preset.',
        schema: {
            shot_id: { type: 'string' },
            direction: { type: ['string', 'null'] },
            lighting: { type: ['object', 'null'], properties: {
                technique: { type: 'string', enum: Object.keys(require('./lighting').TECHNIQUES) },
                type: { type: 'string', enum: Object.keys(require('./lighting').MOODS) },
                key_side: { type: 'string', enum: ['left', 'right'] },
                notes: { type: 'string' },
            } },
            location_view: { type: ['string', 'null'] },
            camera_note: { type: ['string', 'null'] },
        },
        required: ['shot_id'],
    },
    {
        name: 'room_scan_import',
        handler: require('../routes/set-builds').handleSetBuilds, method: 'POST',
        path: a => `/film/locations/${a.location_id}/room-scan/import`,
        body: a => ({ structure: a.structure, dry_run: a.dry_run === true, name: a.name }),
        description:
            'Build a location\'s Previs set from an Apple RoomPlan scan (the CapturedStructure or CapturedRoom as JSON, '
            + 'as the Film Engine iPhone app exports it). FREE: Blender on this Mac. Walls, doors, windows, floors and '
            + 'stairs are built at their measured size, furniture becomes Previs library models, several rooms and '
            + 'storeys scanned in one session keep their places. It becomes the next version of the location\'s world. '
            + 'dry_run: true answers the layout and a report and builds nothing.',
        schema: {
            location_id: { type: 'string' },
            structure: { type: ['object', 'string'], description: 'The RoomPlan JSON.' },
            dry_run: { type: 'boolean' },
            name: { type: 'string' },
        },
        required: ['location_id', 'structure'],
    },
    {
        name: 'previs_timeline',
        handler: handlePrevis, method: 'PUT',
        path: a => `/film/shots/${a.shot_id}/previs/timeline`,
        body: a => {
            const b = {};
            if (a.moves !== undefined) b.moves = a.moves;
            if (a.camera_keys !== undefined) b.cameraKeys = a.camera_keys;
            if (a.duration_ms !== undefined) b.durationMs = a.duration_ms;
            if (a.follow !== undefined) b.follow = a.follow;
            return b;
        },
        description:
            'Set a shot\'s camera MOVE and nothing else: its legs (moves: [{ movement, weight, ease }]), its authored '
            + 'camera keys (camera_keys: [{ t: 0..1, position: [x, y, z], rotation: [yaw, pitch, roll] in degrees, '
            + 'focalMm }]) and its length (duration_ms). FREE. The camera, the people staged and the director\'s notes '
            + 'are kept; send the whole list of whatever you change. follow: { subject (index or name), distance_m '
            + '(default 2.5), height_m (default 1.6), keys? } writes a Steadicam follow instead: ordinary camera keys '
            + 'that walk a moving subject\'s own path that far behind her, aimed at her.',
        schema: {
            shot_id: { type: 'string' },
            moves: { type: 'array', items: { type: 'object' } },
            camera_keys: { type: 'array', items: { type: 'object' } },
            duration_ms: { type: 'number' },
            follow: { type: 'object', properties: {
                subject: { type: ['integer', 'string'] }, distance_m: { type: 'number' },
                height_m: { type: 'number' }, keys: { type: 'integer' } } },
        },
        required: ['shot_id'],
    },
    {
        name: 'previs_video_render',
        handler: handlePrevis, method: 'POST',
        path: a => `/film/shots/${a.shot_id}/previs/render-video`,
        body: a => ({ fps: a.fps, width: a.width }),
        description:
            'Render the shot\'s previz MOVE through its set to an MP4: the camera path the playhead plays and the '
            + 'staged people along their paths, in Blender (Workbench) and encoded by ffmpeg. FREE, on this Mac. '
            + 'Starts it and answers at once; previs_video_list reports progress and the file. Refused by name when '
            + 'the shot is not pinned to a world or Blender is not installed. Each export is a new version.',
        schema: {
            shot_id: { type: 'string' },
            fps: { type: 'number', description: 'default: the project\'s frame rate' },
            width: { type: 'integer', description: 'default 1280; the height follows the project\'s aspect' },
        },
        required: ['shot_id'],
    },
    {
        name: 'previs_video_list',
        handler: handlePrevis, method: 'GET',
        path: a => `/film/shots/${a.shot_id}/previs/videos`,
        description: 'The previz videos exported for a shot, newest first, with their URLs, and the render in flight (frame n of N). FREE.',
        schema: { shot_id: { type: 'string' } },
        required: ['shot_id'],
    },
    {
        name: 'previs_library',
        handler: handlePrevisLibrary, method: 'GET',
        path: a => a.category ? `/film/previs-library?category=${encodeURIComponent(a.category)}` : '/film/previs-library',
        description:
            'The Previs library, FREE: 140 low-poly furniture pieces (CC0) and four people (a man, a woman, a boy and '
            + 'a girl, at real heights), each with its category and its real size in metres [width, depth, height]. '
            + 'Stage one with previs_stage (model: { library: id }) or build it into a set with set_build_render '
            + '(shape: asset).',
        schema: { category: { type: 'string', description: 'people, living, dining, kitchen, bedroom, bathroom, office, lighting, decor, structure, other' } },
        required: [],
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
            subjects: { type: 'array', description: 'Staged objects: figures, boxes, image cards, models. Only NAMED objects reach a prompt — an unnamed object is scaffolding and is not sent to generation, so name anything the frame should contain. A mesh or human may carry model: { library } (a Previs library id: previs_library) or { asset_id } (one of this project\'s 3D models), drawn at its real size.' },
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
        name: 'previs_lock',
        handler: handlePrevis, method: 'POST',
        description: 'Lock directing decisions on a shot so generation cannot drift from them: camera, direction, lighting, location_view, characters, props, movement. Only an APPLIED decision can be locked (previs_apply first) \u2014 a lock promises the scene card value, not a stage still being tried. `all: true` locks every applied decision and signs the blocking off, which is "Lock shot". GET /film/shots/:id/previs reports each decision as none / trying / applied / card_ahead / conflict / locked / stale.',
        path: a => `/film/shots/${a.shot_id}/previs/lock`,
        body: a => (a.all ? { all: true } : { decisions: a.decisions || [] }),
        schema: {
            shot_id: { type: 'string' },
            decisions: { type: 'array', items: { type: 'string' }, description: 'Decision ids to lock.' },
            all: { type: 'boolean', description: 'Lock every applied decision and approve the blocking.' },
        },
        required: ['shot_id'],
    },
    {
        name: 'previs_unlock',
        handler: handlePrevis, method: 'POST',
        description: 'Unlock directing decisions so they can be changed again. `all: true` also withdraws the approval. A decision changed while locked reads as stale until it is applied and locked again.',
        path: a => `/film/shots/${a.shot_id}/previs/unlock`,
        body: a => (a.all ? { all: true } : { decisions: a.decisions || [] }),
        schema: {
            shot_id: { type: 'string' },
            decisions: { type: 'array', items: { type: 'string' } },
            all: { type: 'boolean' },
        },
        required: ['shot_id'],
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
        name: 'shot_audit',
        handler: handleProductionReports, method: 'GET',
        description: 'FREE pre-flight over the shot list — what is wrong with the CARDS before anything '
            + 'generates. The finding that matters is `unresolved_subject`: a subject a card names that '
            + 'reaches the provider as neither a reference picture nor a description, so the model invents '
            + 'it and the result looks like a rendering choice rather than a missing record. That is the '
            + 'only ERROR and the only thing that should stop a run. Also reports subjects in the frame '
            + 'only because the prose happens to name them (they vanish on the next rewrite), subjects on '
            + 'the card the description never uses, missing sizes, negative phrasing, and — across a '
            + 'continuous sequence — a subject that leaves and returns with nothing moving it. Mechanical '
            + 'only: this is the call sheet, not the screenplay notes. Use analysis_brief for those.',
        path: a => `/film/projects/${a.project_id}/shot-audit`
            + (a.shot_id ? `?shot_id=${encodeURIComponent(a.shot_id)}` : ''),
        schema: {
            project_id: { type: 'string' },
            shot_id: { type: 'string', description: 'Audit one shot instead of the whole board.' },
        },
        required: ['project_id'],
    },
    {
        name: 'shots_resync',
        handler: handleProductionReports, method: 'POST',
        description: 'Reconcile the shot cards with the screenplay after a rewrite — the ACTION the drift '
            + 'warning never had. DRY RUN unless you pass apply:true, and it never rewrites a description '
            + 'and never deletes a shot, whatever you pass. It refreshes only what is derivable without a '
            + 'judgement — which characters and props are in the frame, dialogue that still matches word '
            + 'for word, the location — and restamps the fingerprints so the warning clears. Everything '
            + 'needing a person comes back under `needs_a_person`: cards whose scene moved under them, '
            + 'lines that changed or went, and screenplay material no shot covers. Splitting a scene into '
            + 'shots is a coverage decision and is left to the director. Camera, direction note, duration, '
            + 'shot code and shot id are preserved — the id above all, because film_shots.scene_id is ON '
            + 'DELETE CASCADE and losing it takes the blocking, the annotations and the frames too.',
        path: a => `/film/projects/${a.project_id}/shots-resync`,
        body: a => ({ apply: a.apply === true, scene_id: a.scene_id || null }),
        schema: {
            project_id: { type: 'string' },
            apply: { type: 'boolean', description: 'WRITES. Omit or false to preview the plan first.' },
            scene_id: { type: 'string', description: 'Reconcile one scene rather than the whole screenplay.' },
        },
        required: ['project_id'],
    },
    {
        name: 'screenplay_drift',
        handler: handleProductionReports, method: 'GET',
        description: 'Which shots were written from an EARLIER draft of their scene, and what has been generated from them. Run this after any screenplay change: revising a scene does not update the shot cards derived from it, so those cards keep describing the previous story with nothing to show for it. Reports per scene with the next action for each. Warns only — nothing is blocked.',
        path: a => `/film/projects/${a.project_id}/screenplay-drift`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'screenplay_drift_accept',
        handler: handleProductionReports, method: 'POST',
        description: 'Record shots the screenplay moved on without as STILL MATCHING it — the answer when the '
            + 'scene was rewritten but its shot cards still hold (a line of weather, a fixed name). Clears '
            + 'the drift warning without editing any card; a later revision warns again. Only after the '
            + 'person has re-read the scene and said the cards still hold. scene_id or shot_ids narrow it.',
        path: a => `/film/projects/${a.project_id}/screenplay-drift/accept`,
        body: a => { const { project_id, ...rest } = a || {}; return rest; },
        schema: { project_id: { type: 'string' }, scene_id: { type: 'string' }, shot_ids: { type: 'array', items: { type: 'string' } } },
        required: ['project_id'],
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
        name: 'budget_production_estimate',
        handler: handleBudget, method: 'GET',
        description:
            'What making this film will cost: every reference plate (characters x their views, '
            + 'locations, props), one storyboard frame per shot, and the footage, priced on the '
            + 'generators this project would use, at its resolution. FREE: counts and reads the rate '
            + 'book, generates nothing. Counts come from the project: the shots and their lengths, '
            + 'else the screenplay’s measured screen time cut into shots, else the target length. '
            + 'Pass resolution, image_provider/image_model or video_provider/video_model to see what '
            + 'another choice costs; `alternatives` prices the same work on every generator. ATTEMPTS ARE '
            + 'COUNTED: by default 3.5 per plate and frame and 2.5 per clip (usually 3-4 per picture, '
            + 'sometimes 6; 2-3 per clip), with `range` giving the film at the low, likely and high counts '
            + 'and at one attempt. takes_* overrides them. Voice, music and upscaling are not included.',
        path: a => {
            const keys = ['resolution', 'image_provider', 'image_model', 'video_provider', 'video_model',
                'character_views', 'location_views', 'prop_views', 'takes_plates', 'takes_storyboard',
                'takes_footage', 'shot_seconds', 'runtime_seconds'];
            const q = keys.filter(k => a[k] !== undefined && a[k] !== null && a[k] !== '')
                .map(k => `${k}=${encodeURIComponent(a[k])}`);
            return `/film/projects/${a.project_id}/budget/production${q.length ? '?' + q.join('&') : ''}`;
        },
        schema: {
            project_id: { type: 'string', description: 'The project.' },
            resolution: { type: 'string', description: 'A resolution preset id (720p, 1080p, 2k, 4k_uhd, 4k_dci, 8k) or WxH. Defaults to the project’s.' },
            image_provider: { type: 'string', description: 'Price plates and frames on this provider instead.' },
            image_model: { type: 'string', description: 'And this model of it.' },
            video_provider: { type: 'string', description: 'Price the footage on this provider instead.' },
            video_model: { type: 'string', description: 'And this model of it.' },
            character_views: { type: 'number', description: 'Pictures per character (default 4: front, two profiles, back).' },
            location_views: { type: 'number', description: 'Pictures per location (default 4).' },
            prop_views: { type: 'number', description: 'Pictures per prop (default 1).' },
            takes_plates: { type: 'number', description: 'Attempts per plate (default 3.5: usually 3-4, sometimes 6).' },
            takes_storyboard: { type: 'number', description: 'Attempts per frame (default 3.5).' },
            takes_footage: { type: 'number', description: 'Attempts per clip (default 2.5: usually 2-3).' },
            shot_seconds: { type: 'number', description: 'Average shot length when the film has no shots yet (default 4).' },
            runtime_seconds: { type: 'number', description: 'The running time, overriding what the screenplay measures.' },
        },
        required: ['project_id'],
    },
    {
        name: 'gridlight_video_capabilities',
        handler: handleProviders, method: 'GET',
        description:
            'What the Gridlight gateway\u2019s video models accept, read from the gateway itself '
            + '(GET /media/capabilities). FREE: reads a manifest, generates nothing. Per model: whether '
            + 'it is available (and why not), whether it makes audio, its body-size ceiling, and its '
            + 'inputs \u2014 which reference kinds (keyframe, clip, character, location, prop, transform), '
            + 'how many of each, where each can be placed, which transform effects exist, and what '
            + 'excludes what. Read this before video_generate on a Gridlight project: support differs '
            + 'per model (LTX-2.5 takes all six kinds, Wan 2.2 one start image or clip, MiniMax H3 none), '
            + 'and a reference the chosen model does not take is dropped and reported. A 503 means the '
            + 'video server is off \u2014 a normal state, not a crash.',
        path: a => `/film/providers/gridlight/video-capabilities${a.refresh ? '?refresh=1' : ''}`,
        schema: {
            refresh: { type: 'boolean', description: 'Optional. Re-read the gateway instead of the one-minute cache.' },
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
        name: 'delivery_check',
        handler: handleProductionReports, method: 'GET',
        description: 'FREE. Every shot\'s SELECTED clip measured from its file against the project\'s delivery size (target_resolution): ok, below (with the measured size and the fix — upscale it), no_clip or unreadable. Run it before a conform or a Premiere handover; a generator that cannot render the delivery size gives its best, and this is where that shortfall is caught.',
        path: a => `/film/projects/${a.project_id}/delivery-check`,
        schema: { project_id: { type: 'string' } },
        required: ['project_id'],
    },
    {
        name: 'run_plan',
        handler: handleProductionReports, method: 'GET',
        description: 'What a generation run would do, in what order, and what it would cost \u2014 BEFORE spending anything. Skips work that is already current, so re-running after a small edit costs a small amount. order=model loads each model once (cheapest, nothing finished until the end); order=shot walks one shot through every step (a finished shot early, at the cost of reloading models per shot). Returns HTTP 402 and refused:true when the projected cost would exceed the project budget or a `max_credits` ceiling given for this run — and ALSO when the card audit finds a subject that would reach the provider as neither a reference picture nor a description, because that frame comes back with something invented in it and the money is gone. `audit` carries the counts either way; ignore_audit=true generates regardless.',
        path: a => {
            const q = [];
            if (a.order) q.push(`order=${encodeURIComponent(a.order)}`);
            if (a.ignore_budget) q.push('ignore_budget=true');
            if (a.ignore_audit) q.push('ignore_audit=true');
            if (a.max_credits) q.push(`max_credits=${encodeURIComponent(a.max_credits)}`);
            return `/film/projects/${a.project_id}/run-plan${q.length ? '?' + q.join('&') : ''}`;
        },
        schema: {
            project_id: { type: 'string' },
            order: { type: 'string', description: '"model" (default) or "shot".' },
            ignore_budget: { type: 'boolean', description: 'Plan anyway when it would exceed the budget.' },
            ignore_audit: { type: 'boolean', description:
                'Generate even though a card names a subject the provider will receive neither a '
                + 'picture nor a description of. Say it deliberately: the frame comes back with that '
                + 'subject invented, and it will look like a choice rather than a gap.' },
            max_credits: { type: 'number', description:
                'A ceiling for THIS run. The project budget refuses the last call that would take '
                + 'the production past its total; this bounds one run before its first generation, '
                + 'which is what stops a loop rather than a single request. `ignore_budget` does '
                + 'not lift it — a run that could wave away the limit it was given would be given none.' },
        },
        required: ['project_id'],
    },
    {
        name: 'conform_plan',
        handler: handleProductionReports, method: 'GET',
        description: 'FREE. What conforming the film would do: which cut of each shot ships (video_final over video_synced over video_raw), in running order, whether the project audio mix or the clips\u2019 own audio is the master audio, the total length, and which shots have NO footage \u2014 a missing shot refuses the conform rather than shortening the film. Also which executor is available (local ffmpeg). Read it before conform_run.',
        path: a => `/film/projects/${a.project_id}/conform`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'conform_run',
        handler: handleProductionReports, method: 'POST',
        description: 'Turn the shot masters into ONE film file: every shot\u2019s best cut joined in running order, the project audio mix laid under it when one exists, registered as the project master (asset_type video_final, metadata.kind project_master) and served at the returned url. Spends no provider credits \u2014 it runs local ffmpeg \u2014 but takes as long as the film is long. Running it again REPLACES the previous master rather than adding a second one. Refuses (409) when a shot has no footage or the cut misses a target runtime; run conform_plan first to see why.',
        path: a => `/film/projects/${a.project_id}/conform`,
        body: a => (a.filename ? { filename: a.filename } : {}),
        schema: {
            project_id: { type: 'string' },
            filename: { type: 'string', description: 'Master filename without extension. Default film_master. A different name writes a second master beside the first rather than replacing it.' },
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
        name: 'music_midi_get',
        handler: handleMusicMidi, method: 'GET',
        description: 'FREE. A cue\u2019s NOTES and the contract for writing them: the cue\u2019s length in milliseconds '
            + 'and where it came from, the one-frame tolerance, the 128 General MIDI programs, and the plan and '
            + 'parts already written \u2014 each part marked agent or performed. Read music_brief for what the scene '
            + 'is, then this, then write with music_midi_write.',
        path: a => `/film/music-cues/${a.cue_id}/midi`,
        schema: { cue_id: { type: 'string' } }, required: ['cue_id'],
    },
    {
        name: 'music_midi_write',
        handler: handleMusicMidi, method: 'PUT',
        description: 'FREE \u2014 nothing is generated; YOU compose. Write a cue as PARTS OVER A HARMONIC PLAN and it '
            + 'is stored as a Standard MIDI File with one track per part, which a DAW opens as separate '
            + 'instruments. First fix the plan: tempo_bpm, meter, key, chord changes and sections, all in '
            + 'MILLISECONDS from the start of the cue (never beats \u2014 the cut is in milliseconds). Then write one '
            + 'part per instrument against those chords: { name, instrument, program (General MIDI 0\u2013127) or '
            + 'drums: true, notes: [{ start_ms, duration_ms, pitch, velocity }] }. Every note must end inside the '
            + 'cue; a refusal names the part and the note. The director plays melodies themselves: a part they '
            + 'imported with music_midi_import_part is KEPT through your rewrite unless you name it in '
            + 'replace_performed, so write the harmony and leave the tune to them when they have played one.',
        path: a => `/film/music-cues/${a.cue_id}/midi`,
        body: a => { const { cue_id, ...rest } = a || {}; return rest; },
        schema: {
            cue_id: { type: 'string' },
            plan: { type: 'object', description: '{ tempo_bpm, meter "4/4", key "D minor", chords: [{ start_ms, symbol }], sections: [{ name, start_ms, end_ms }] }' },
            parts: { type: 'array', description: 'One per instrument: { name, instrument, program | drums, notes: [{ start_ms, duration_ms, pitch, velocity }] }.' },
            replace_performed: { type: 'array', items: { type: 'string' }, description: 'Names of performed parts you may write over. Omit to keep what the director played.' },
        },
        required: ['cue_id', 'plan', 'parts'],
    },
    {
        name: 'music_midi_import_part',
        handler: handleMusicMidi, method: 'POST',
        description: 'FREE. Replace ONE part of a cue with a .mid the director PLAYED \u2014 a melody performed in '
            + 'Ableton, say \u2014 or add it as a new part. Only that part changes; the plan and the other parts '
            + 'stay, and the original file is kept beside the rebuilt one. With no notes written yet the plan '
            + 'is taken from the file\u2019s own tempo and meter. A take longer than the cue is refused rather '
            + 'than cut; trim it in the DAW or shift it with offset_ms.',
        path: a => `/film/music-cues/${a.cue_id}/midi/parts/${encodeURIComponent(a.part)}/import`,
        body: a => ({ data: a.file, name: a.name, track: a.track, instrument: a.instrument, program: a.program, drums: a.drums, offset_ms: a.offset_ms }),
        schema: {
            cue_id: { type: 'string' },
            part: { type: 'string', description: 'The part this take replaces or becomes, e.g. "melody".' },
            file: { type: 'string', description: 'data:audio/midi;base64,...' },
            name: { type: 'string', description: 'The original file name, kept for the record.' },
            track: { type: 'string', description: 'Which track of the file to take, by index or name. Omit to take every track with notes.' },
            instrument: { type: 'string' },
            program: { type: 'number', description: 'General MIDI program 0\u2013127. Omit to use the file\u2019s own.' },
            drums: { type: 'boolean' },
            offset_ms: { type: 'number', description: 'Shift the take later (or earlier, negative) against the cue.' },
        },
        required: ['cue_id', 'part', 'file'],
    },
    {
        name: 'music_midi_delete',
        handler: handleMusicMidi, method: 'DELETE',
        description: 'Remove a cue\u2019s note file. Files the director played are kept in the project\u2019s music folder.',
        path: a => `/film/music-cues/${a.cue_id}/midi`,
        schema: { cue_id: { type: 'string' } }, required: ['cue_id'],
    },
    {
        name: 'instrument_list',
        handler: handleInstruments, method: 'GET',
        description: 'FREE. The director\u2019s own instruments \u2014 one sound out of one of their libraries, as a plugin '
            + 'plus the patch that recalls it. Search with q (name, library, vendor or tag). An instrument marked '
            + 'unavailable has lost its plugin or its patch and will not play. Use an id from here with '
            + 'music_midi_render_part.',
        path: a => `/film/instruments${a.q ? `?q=${encodeURIComponent(a.q)}` : ''}`,
        schema: { q: { type: 'string', description: 'name, library, vendor or tag' } }, required: [],
    },
    {
        name: 'instrument_get',
        handler: handleInstruments, method: 'GET',
        description: 'FREE. One instrument: which plugin plays it, where its patch came from, and whether it can play right now.',
        path: a => `/film/instruments/${a.instrument_id}`,
        schema: { instrument_id: { type: 'string' } }, required: ['instrument_id'],
    },
    {
        name: 'instrument_catalogue',
        handler: handleInstruments, method: 'GET',
        description: 'FREE, and it stores NOTHING. The director\u2019s own sounds, read live out of Kontakt\u2019s index: '
            + 'name, the library it came from, its bank, what kind of sound it is and the file it lives in. Search with '
            + 'q (a name, a library, a tag \u2014 "cello", "Ethereal Earth", "metallic"). This is how you choose a sound '
            + 'for a part: find it here, then it is captured or played and only THEN does it become a row in Film '
            + 'Engine\u2019s own instrument library. A sound marked unavailable has lost its file.',
        path: a => {
            const q = [];
            if (a.q) q.push(`q=${encodeURIComponent(a.q)}`);
            if (a.library) q.push(`library=${encodeURIComponent(a.library)}`);
            if (a.kind) q.push(`kind=${encodeURIComponent(a.kind)}`);
            if (a.limit) q.push(`limit=${encodeURIComponent(a.limit)}`);
            return `/film/instruments/catalogue${q.length ? `?${q.join('&')}` : ''}`;
        },
        schema: {
            q: { type: 'string', description: 'a name, a library or a tag' },
            library: { type: 'string', description: 'exactly one library, e.g. "Ethereal Earth"' },
            kind: { type: 'string', description: 'nki (an instrument), nksn (a snapshot), nkt, nksf' },
            limit: { type: 'number' },
        },
        required: [],
    },
    {
        name: 'instrument_scan',
        handler: handleInstruments, method: 'POST',
        description: 'FREE, local, and it stores NOTHING. What NKS presets (.nksf) are on this machine, with their '
            + 'names and libraries. A preset becomes a row in Film Engine only when something PLAYS it \u2014 pass its '
            + 'preset_path to music_midi_render_part. Kontakt libraries usually ship .nki instruments and snapshots '
            + 'rather than NKS presets; browse those with instrument_catalogue.',
        path: () => '/film/instruments/scan',
        body: a => { const { ...rest } = a || {}; return rest; },
        schema: {
            plugin: { type: 'string', description: 'Which plugin plays them. Defaults to Kontakt 8.' },
            roots: { type: 'array', items: { type: 'string' }, description: 'Folders to search. Defaults to the NI content folders.' },
            limit: { type: 'number' },
        },
        required: [],
    },
    {
        name: 'instrument_update',
        handler: handleInstruments, method: 'PUT',
        description: 'Rename an instrument, or re-tag it so it can be found among thousands. Merged, never replaced.',
        path: a => `/film/instruments/${a.instrument_id}`,
        body: a => { const { instrument_id, ...rest } = a || {}; return rest; },
        schema: {
            instrument_id: { type: 'string' },
            name: { type: 'string' }, library: { type: 'string' }, vendor: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
        },
        required: ['instrument_id'],
    },
    {
        name: 'instrument_delete',
        handler: handleInstruments, method: 'DELETE',
        description: 'Forget an instrument. A captured patch is deleted with it; an NKS preset belongs to the library '
            + 'and is left where it is. Tracks that used it keep their takes.',
        path: a => `/film/instruments/${a.instrument_id}`,
        schema: { instrument_id: { type: 'string' } }, required: ['instrument_id'],
    },
    {
        name: 'music_midi_render_part',
        handler: handleMusicMidi, method: 'POST',
        description: 'FREE \u2014 runs on this machine; no provider is billed. Play ONE part of a cue through one of the '
            + 'director\u2019s own instruments (Kontakt and their libraries) and keep it as that part\u2019s audio. This is how '
            + 'a composition is built here: write the parts with music_midi_write, give each one an instrument from '
            + 'instrument_list, render them, and the cue exists part by part. Needs the instrument sidecar running; a '
            + 'render that comes back silent is refused rather than kept.',
        path: a => `/film/music-cues/${a.cue_id}/midi/parts/${encodeURIComponent(a.part)}/render`,
        body: a => ({ instrument_id: a.instrument_id, preset_path: a.preset_path, plugin: a.plugin }),
        schema: {
            cue_id: { type: 'string' },
            part: { type: 'string', description: 'The part to play, by name, from music_midi_get.' },
            instrument_id: { type: 'string', description: 'From instrument_list \u2014 a sound already in the library.' },
            preset_path: { type: 'string', description: 'Or an NKS preset from instrument_scan: it joins the library the '
                + 'moment it plays, so nothing is indexed until it is used.' },
            plugin: { type: 'string', description: 'Which plugin plays that preset. Defaults to Kontakt 8.' },
        },
        required: ['cue_id', 'part'],
    },
    {
        name: 'music_midi_render_plan',
        handler: handleMusicMidi, method: 'GET',
        description: 'FREE. What playing a cue\u2019s notes through instruments on this machine would do: the parts, the '
            + 'SoundFont library and its licence, the length, and anything missing (FluidSynth, a SoundFont, the encoder) '
            + 'with how to fix it. Read before music_midi_render.',
        path: a => `/film/music-cues/${a.cue_id}/midi/render/plan`,
        schema: { cue_id: { type: 'string' } }, required: ['cue_id'],
    },
    {
        name: 'music_midi_render',
        handler: handleMusicMidi, method: 'POST',
        description: 'FREE \u2014 runs on this machine; no provider is billed. Play a cue\u2019s written notes through a '
            + 'SoundFont (FluidSynth) into a 48kHz WAV exactly the cue\u2019s length and make it the cue\u2019s audio. The '
            + 'render is read back and refused if it is silent, and the sample library\u2019s licence is recorded on it. '
            + 'Needs notes (music_midi_write, or a played part) and a SoundFont installed; music_midi_render_plan says what is missing.',
        path: a => `/film/music-cues/${a.cue_id}/midi/render`,
        schema: { cue_id: { type: 'string' } }, required: ['cue_id'],
    },
    {
        name: 'music_brief',
        handler: handleMusicGen, method: 'GET',
        description: 'Everything the engine knows about a scene, for deciding what it should SOUND like: the heading, what happens, who is in it, how many lines of dialogue, how many shots, the film\u2019s genre and the musical clauses of its look — plus the real length of the cut and where that number came from. It returns NO conclusion: what a scene should sound like is a judgement, and you are the model here. Decide the mood, genre, instruments and a reference track, then store them with music_cue_create; a cue somebody wrote always beats the derivation. Watch the dialogue count — a wall-to-wall dialogue scene wants sparse underscore that never becomes melodic, because a melody there fights the words. SPENDS NOTHING.',
        path: a => `/film/scenes/${a.scene_id}/music/brief`,
        schema: { scene_id: { type: 'string' } }, required: ['scene_id'],
    },
    {
        name: 'music_capabilities',
        handler: handleMusicGen, method: 'GET',
        description: 'Free — spends nothing. What this project\'s music provider can and cannot do, per workflow: compose a whole cue, generate native parts, separate a recording into stems, condition on a reference, condition on the picture, regenerate a selected range. Each is available, planned or unsupported WITH THE REASON, its limits (lengths, models, stem counts), a cost hint from the rate book when one exists, the neutral plan and result schemas, and which other providers could do it. Read it before asking for any of these: a workflow the provider does not serve is refused, never attempted.',
        path: a => `/film/projects/${a.project_id}/music/capabilities`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
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
            held: { type: 'boolean', description: 'true HOLDS this node: every batch run skips it and says so, while the film keeps it (conform and export ignore a hold). false releases it. Free.' },
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
        name: 'export_premiere_scenes_plan',
        handler: handleNLEExport, method: 'GET',
        description: 'FREE. What the Premiere handover with one folder per scene would hold: each scene\u2019s folder name, the SELECTED clip of every shot (named by shot code) and the scene\u2019s sound, and anything missing. Nothing is written. Read it before export_premiere_scenes.',
        path: a => `/film/projects/${a.project_id}/export/premiere-scenes`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'export_premiere_scenes',
        handler: handleNLEExport, method: 'POST',
        description: 'Write the Premiere handover with ONE FOLDER PER SCENE into the project\u2019s Exports folder: Scene_NN_<heading>/Video holds each shot\u2019s SELECTED clip named by shot code, Sound holds its dialogue, effects and the scene\u2019s beds, and a Premiere XML carries the cut as a sequence plus a bin per scene. Media is COPIED, never moved. Spends nothing. Refuses when no shot has a clip yet.',
        path: a => `/film/projects/${a.project_id}/export/premiere-scenes`,
        schema: { project_id: { type: 'string' } }, required: ['project_id'],
    },
    {
        name: 'shot_upscale_preview',
        handler: handlePostProduction, method: 'GET',
        description: 'FREE. What upscaling a shot\'s clip would do: the clip (the SELECTED one, or asset_id), measured from the file; the project\'s delivery size; the factor or tier the upscaler picks to reach it; the request, and the price. `model` names an upscaler. On MuAPI: topaz-video-upscale (2x or 4x), ai-video-upscaler or ai-video-upscaler-pro (to 1080p, 2K or 4K), flux-3-video-upscaler (prompted). On Topaz\'s own API (needs a Topaz key): slp-2.6 Starlight Precise 2.6 (the best finish for generated footage, to 4K), slf-3 Starlight Fast 3 (same price, about 4x faster), ast-2 Astra 2 (creative: adds detail, takes prompt/creativity/realism/sharp), prob-4 Proteus (precision, cheapest). On Magnific (needs a Magnific key): magnific-video-upscaler (creative; creativity, flavor), magnific-video-upscaler-turbo (the same, faster), magnific-video-upscaler-precision (faithful; strength), magnific-video-upscaler-topaz (Starlight through Magnific; enhancement_model). `upscalers` lists each with its price for THIS clip. Read this before shot_upscale.',
        path: a => `/film/shots/${a.shot_id}/post/upscale/preview?model=${encodeURIComponent(a.model || 'topaz-video-upscale')}${a.asset_id ? `&asset_id=${encodeURIComponent(a.asset_id)}` : ''}`,
        schema: { shot_id: { type: 'string' }, model: { type: 'string' }, asset_id: { type: 'string', description: 'A clip version of this shot; omitted, the selected clip.' } },
        required: ['shot_id'],
    },
    {
        name: 'shot_upscale',
        handler: handlePostProduction, method: 'POST',
        description: 'SPENDS (MuAPI, Topaz or Magnific, by the model named). Upscale a shot\'s clip to the project\'s delivery size: the clip is uploaded to that provider, enlarged by the named upscaler, and saved as a NEW version that becomes the shot\'s selected clip; the original is kept. `model` as in shot_upscale_preview; omitted, the project\'s post provider runs its default finish (on Seedance, the video-edit re-render at 4K, which bills the whole source). Read shot_upscale_preview first.',
        path: a => `/film/shots/${a.shot_id}/post/upscale`,
        body: a => ({ ...(a.model ? { model: a.model } : {}), ...(a.asset_id ? { asset_id: a.asset_id } : {}),
            ...Object.fromEntries(['sharpness', 'creativity', 'realism', 'sharp', 'prompt', 'sharpen', 'smart_grain', 'fps_boost', 'flavor', 'strength', 'enhancement_model', 'noise', 'target_fps'].filter(k => a[k] !== undefined).map(k => [k, a[k]])) }),
        schema: { shot_id: { type: 'string' }, model: { type: 'string' }, asset_id: { type: 'string' },
            sharpness: { type: 'number', description: 'Starlight Precise 2.6 only: 1 to 5.' },
            creativity: { type: 'number', description: 'Astra 2 only: 0 to 1.' },
            realism: { type: 'number', description: 'Astra 2 only: 0 to 1.' },
            sharp: { type: 'number', description: 'Astra 2 only: 0 blur, 0.5 passthrough, 1 sharpen.' },
            prompt: { type: 'string', description: 'Astra 2 only: what the added detail should be.' },
            sharpen: { type: 'number', description: 'Magnific only: 0 to 100.' },
            smart_grain: { type: 'number', description: 'Magnific only: film grain, 0 to 100.' },
            fps_boost: { type: 'boolean', description: 'Magnific only: raise the frame rate.' },
            flavor: { type: 'string', description: 'Magnific creative only: vivid or natural.' },
            strength: { type: 'number', description: 'Magnific precision only: 0 original to 100 fully upscaled.' },
            enhancement_model: { type: 'string', description: 'Magnific Topaz only: starlight_precise_2_5 or starlight_fast_2.' },
            noise: { type: 'number', description: 'Magnific Topaz only: 0 to 1.' },
            target_fps: { type: 'number', description: 'Magnific Topaz only: 15 to 60, interpolated.' } },
        required: ['shot_id'],
    },
    {
        name: 'backup_folder_status',
        handler: handleBackups, method: 'GET',
        description: 'FREE. Where this machine\'s database is backed up (the backup_dir set in Settings), how often, how many are kept, the snapshots already there, when the next is due, and the steps to restore one. Each person sets their own folder; snapshots go in "Film Engine Backups/<user>@<machine>" inside it.',
        path: () => '/film/backups/folder',
        schema: {}, required: [],
    },
    {
        name: 'backup_folder_set',
        handler: handleAppSettings, method: 'PUT',
        description: 'Choose where and how often this machine backs up: backup_dir (a full path, e.g. a Dropbox or Google Drive folder; \'\' turns scheduled backups off), backup_every_hours (0 = only when asked), backup_keep (snapshots kept), backup_projects (also write each project\'s rows as JSON). Send only what changes. Takes effect without a restart.',
        path: () => '/film/settings',
        body: a => Object.fromEntries(['backup_dir', 'backup_every_hours', 'backup_keep', 'backup_projects']
            .filter(k => a && a[k] !== undefined).map(k => [k, a[k]])),
        schema: {
            backup_dir: { type: 'string', description: 'A full path. Blank turns scheduled backups off.' },
            backup_every_hours: { type: 'number', description: 'Hours between backups; 0 writes only on backup_folder_run.' },
            backup_keep: { type: 'number', description: 'How many snapshots to keep; older ones Film Engine wrote are deleted.' },
            backup_projects: { type: 'boolean', description: 'Also write each project\'s rows as JSON.' },
        },
        required: [],
    },
    {
        name: 'backup_folder_run',
        handler: handleBackups, method: 'POST',
        description: 'Write a backup to the backup folder NOW: a consistent snapshot of the whole database (VACUUM INTO, safe while Film Engine runs), plus each project\'s rows as JSON when backup_projects is on. Media is not copied; it lives in each project\'s own folder. Refuses when no backup_dir is set. Spends nothing.',
        path: () => '/film/backups/folder/run',
        schema: {}, required: [],
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
            lighting_technique: { type: 'string', enum: Object.keys(require('./lighting').TECHNIQUES),
                description: 'The lighting technique every shot here takes unless it names its own (Rembrandt, three-point, window-motivated…). Reaches the prompt and lights Previs.' },
            lighting_key_side: { type: 'string', enum: ['left', 'right'], description: 'Which side of camera the key light comes from.' },
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
            generation: { type: 'object', description: '{negative_prompt} \u2014 what this shot\u2019s frame and clip must avoid, added to the default negatives. MERGES; null on a key clears it. Some video providers (Runway) accept no negative prompt at all, so a rule that must hold everywhere belongs in the description too.' },
            beats: { type: 'array', items: { type: 'string' }, description: 'Ordered subject beats for a shot that evolves, compiled as "First X, then Y". Write these ONLY when the shot genuinely has stages \u2014 micromanaging every second makes some models less reliable, and a shot needing more than a few beats is usually one that should be split.' },
            duration_seconds: { type: 'number' },
            notes: { type: 'string' },
            held: { type: 'boolean', description: 'true HOLDS this node: every batch run skips it and says so, while the film keeps it (conform and export ignore a hold). false releases it. Free.' },
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
        name: 'storyboard_angles_preview',
        handler: handleStoryboard, method: 'POST',
        description: 'FREE. The four prompts an angle exploration would send for this shot \u2014 one camera '
            + 'each \u2014 their size (the project\u2019s resolution) and what the four cost. Read it before '
            + 'storyboard_angles. Pass angles to compose your own four cameras for this shot.',
        path: a => `/film/shots/${a.shot_id}/storyboard/angles-preview`,
        body: a => ({ angles: a.angles }),
        schema: {
            shot_id: { type: 'string' },
            angles: {
                type: 'array', items: { type: 'string' },
                description: 'Up to four camera instructions, A to D, e.g. "over her shoulder toward the door, '
                    + '85mm". Missing ones are filled from the defaults: as written, reverse, low and wider, '
                    + 'high and tighter.',
            },
        },
        required: ['shot_id'],
    },
    {
        name: 'storyboard_angles',
        handler: handleStoryboard, method: 'POST',
        description: 'Explore FOUR ANGLES on one shot: four separate Nano Banana Pro generations, one camera '
            + 'each, at the project\u2019s resolution, joined into a contact sheet. Nothing replaces the board '
            + 'frame \u2014 the four come back as candidates A\u2013D, and storyboard_angles_pick makes one the '
            + 'shot. Answers at once with a token and runs in the background; poll storyboard_angles_list. '
            + 'Costs FOUR images.',
        path: a => `/film/shots/${a.shot_id}/storyboard/angles`,
        body: a => ({ angles: a.angles, use_anchor: a.use_anchor, direction_mode: a.direction_mode }),
        schema: {
            shot_id: { type: 'string' },
            angles: { type: 'array', items: { type: 'string' },
                description: 'Up to four camera instructions, A to D. Defaults fill the rest.' },
            use_anchor: { type: 'boolean', description: 'false skips the project anchor for these four.' },
            direction_mode: { type: 'string', description: 'action (default) or camera.' },
        },
        required: ['shot_id'],
    },
    {
        name: 'storyboard_angles_list',
        handler: handleStoryboard, method: 'GET',
        description: 'FREE. A shot\u2019s angle explorations: each run\u2019s candidates A\u2013D with their '
            + 'pictures, the contact sheet, whether it is still running, and which angle was picked. Pass '
            + 'token for one run.',
        path: a => `/film/shots/${a.shot_id}/storyboard/angles${a.token ? `/${a.token}` : ''}`,
        schema: {
            shot_id: { type: 'string' },
            token: { type: 'string', description: 'One exploration, from storyboard_angles.' },
        },
        required: ['shot_id'],
    },
    {
        name: 'storyboard_angles_pick',
        handler: handleStoryboard, method: 'POST',
        description: 'Make one explored angle THE SHOT: it becomes a new frame version on the board, what the '
            + 'shot showed is kept as an earlier version, and the other candidates stay so you can change '
            + 'your mind with another pick. Free \u2014 a file copy. A locked board refuses it.',
        path: a => `/film/shots/${a.shot_id}/storyboard/angles/${a.token}/pick`,
        body: a => ({ slot: a.slot, ignore_lock: a.ignore_lock }),
        schema: {
            shot_id: { type: 'string' },
            token: { type: 'string' },
            slot: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
            ignore_lock: { type: 'boolean' },
        },
        required: ['shot_id', 'token', 'slot'],
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

// ── Set 3b: the score session ──────────────────────────────────────────────
//
// The agent host is the model here, so a score session an agent cannot reach
// is one that must be built by hand. Every child kind the HTTP route exposes
// gets list / create / update / delete, the session gets its nine operations,
// and all of them dispatch THROUGH handleMusicSessions by the same shim —
// nothing is reimplemented beside the route. The schemas are DERIVED: each
// table's fields come from its validator's own defaults, every enum from the
// contract's VOCABULARY and every bound from RANGES, so the model is told what
// the database will accept before it tries.
const { handleMusicSessions, CHILD_KINDS: MUSIC_KINDS } = require('../routes/music-sessions');
const musicContracts = require('./music-session');
const musicStems = require('./music-stems');
const musicRenderer = require('./music-renderer');
const musicSeparation = require('./music-separation');
const musicGeneration = require('./music-generation');

const MUSIC_SINGULAR = { tracks: 'track', clips: 'clip', markers: 'marker', 'emotion-ranges': 'emotion', automation: 'automation' };
const MUSIC_SEED = { film_music_clips: { duration_ms: 1000 }, film_music_emotion_ranges: { end_ms: 1000 },
    film_music_tracks: { instrument_id: null, notes: null } };
const MUSIC_WHAT = {
    tracks: 'a lane with a role (instrument, family, bus, reference, picture) and mixer state: gain, pan, mute, solo, order',
    clips: 'an immutable asset placed on a track: start_ms and duration_ms in the session clock, source_offset_ms into the file, fades, loop and warp policy, take group and status, and source_kind (generated, native_part, separated, rendered, imported)',
    markers: 'a moment on the ruler: a shot boundary, a hit, a section, a sync point, cue in/out, or a note, at position_ms',
    'emotion-ranges': 'a span of the emotional arc with valence (-1..1), arousal, intensity and confidence (0..1), a label, its source and its status — an ai_proposal stays proposed until a person accepts it, and nothing paid rests on a proposal',
    automation: 'a parameter over time on a track (or one clip): gain, pan, mute, send or filter, as sorted { at_ms, value } points',
};
const MUSIC_HELP = {
    edit_id: 'A cut imported from an editor (edit_list). The score is written against THAT cut: its length is the edit\'s, its brief follows the editor\'s timing, and its stems line up with the edit\'s first frame in Premiere.',
    instrument_id: 'Which of the director’s own sounds plays this lane, from instrument_list. Set it with the part, then play it with music_track_render.',
    notes: 'THE PART THIS LANE PLAYS: { program, drums, notes: [{ start_ms, duration_ms, pitch, velocity }] }, in MILLISECONDS, pitch 0-127 with 60 as middle C. Write a melody here and play it with music_track_render.',
    start_ms: 'Whole milliseconds in the session clock — the cut is in milliseconds, never beats.',
    duration_ms: 'Whole milliseconds; must be > 0.',
    source_offset_ms: 'Where in the source file the clip begins. Keep 0 on import to preserve leading silence.',
    tempo_map: 'List of { at_ms, bpm, numerator, denominator }, sorted, starting at 0. Empty means constant tempo not yet stated.',
    points: 'List of { at_ms, value }, sorted by at_ms, value inside the parameter\'s own range.',
    track_id: 'A track of this session.',
    role: 'Free text inside role_kind: "cello", "strings", "music bus".',
};

/*
 * Path builders, written out per kind rather than derived from a string:
 * tests/mcp-tools.test.js reads each builder's own source for the argument it
 * forwards, so a builder that reaches `a[idArg]` through a variable reads as
 * a tool whose argument nothing consumes.
 */
const MUSIC_PATHS = {
    tracks: {
        list: a => `/film/music-sessions/${a.session_id}/tracks`,
        item: a => `/film/music-sessions/${a.session_id}/tracks/${a.track_id}`,
    },
    clips: {
        list: a => `/film/music-sessions/${a.session_id}/clips`,
        item: a => `/film/music-sessions/${a.session_id}/clips/${a.clip_id}`,
    },
    markers: {
        list: a => `/film/music-sessions/${a.session_id}/markers`,
        item: a => `/film/music-sessions/${a.session_id}/markers/${a.marker_id}`,
    },
    'emotion-ranges': {
        list: a => `/film/music-sessions/${a.session_id}/emotion-ranges`,
        item: a => `/film/music-sessions/${a.session_id}/emotion-ranges/${a.emotion_id}`,
    },
    automation: {
        list: a => `/film/music-sessions/${a.session_id}/automation`,
        item: a => `/film/music-sessions/${a.session_id}/automation/${a.automation_id}`,
    },
};

function musicSchemaFor(table, omit) {
    const seed = musicContracts.VALIDATORS[table](MUSIC_SEED[table] || {});
    const out = {};
    for (const key of Object.keys(seed.value)) {
        if ((omit || []).includes(key)) continue;
        const vocab = musicContracts.VOCABULARY[`${table}.${key}`];
        const range = musicContracts.RANGES[`${table}.${key}`];
        let prop;
        if (['muted', 'soloed'].includes(key)) prop = { type: 'boolean' };
        else if (vocab) prop = { type: typeof vocab[0] === 'number' ? 'integer' : 'string', enum: vocab };
        else if (range) prop = { type: 'number', minimum: range.min, maximum: range.max };
        else if (/_ms$/.test(key) || key === 'sort_order') prop = { type: 'integer' };
        else if (['gain_db', 'frame_rate', 'cost_usd'].includes(key)) prop = { type: 'number' };
        else if (['tempo_map', 'points'].includes(key)) prop = { type: 'array' };
        else if (table === 'film_music_tracks' && key === 'notes') prop = { type: 'object' };
        else if (key === 'params') prop = { type: 'object' };
        else prop = { type: 'string' };
        if (MUSIC_HELP[key]) prop.description = MUSIC_HELP[key];
        out[key] = prop;
    }
    return out;
}

function musicSessionTools() {
    const H = handleMusicSessions;
    const S = { session_id: { type: 'string' } };
    const dropIds = (...ids) => a => { const rest = { ...a }; for (const id of ids) delete rest[id]; return rest; };
    const tools = [
        {
            name: 'music_session_list', handler: H, method: 'GET',
            description: 'Free. The score sessions of a project, each with the picture unit it is attached to (a sequence, or a scene as the fallback) and its lifecycle status.',
            path: a => `/film/projects/${a.project_id}/music-sessions`,
            schema: { project_id: { type: 'string' } }, required: ['project_id'],
        },
        {
            name: 'music_session_create', handler: H, method: 'POST',
            description: 'Creates a score session for an edit made in Premiere (edit_id — the finished cut, the usual choice once there is one), a picture sequence (sequence_id), or a scene (scene_id). Created as a draft and STAMPED with the brief it was written against, so drift is sayable from the first read. Writes one row; spends nothing.',
            path: a => `/film/projects/${a.project_id}/music-sessions`,
            body: dropIds('project_id'),
            schema: { project_id: { type: 'string' }, sequence_id: { type: 'string', description: 'The ordered picture sequence this score is for.' },
                scene_id: { type: 'string', description: 'Fallback: a scene, when the project has no sequence.' },
                ...musicSchemaFor('film_music_sessions', ['status', 'sequence_id', 'scene_id', 'script_id']) },
            required: ['project_id'],
        },
        {
            name: 'music_session_get', handler: H, method: 'GET',
            description: 'Free. The whole ScoreSession read model: the session, its picture unit, tracks with their clips and automation, emotion ranges, markers, operations, the derived length, and the vocabulary every field accepts. The same shape the page and the bounce read.',
            path: a => `/film/music-sessions/${a.session_id}`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_session_brief', handler: H, method: 'GET',
            description: 'Free — spends nothing. The compiled ScoreBrief: the shots in play order with real timings and cameras, the exact screenplay passages, scenes, cast and dialogue density, the look, cues with sections, the accepted emotional arc and existing motifs, with provenance per field and fingerprints. Read it before writing any cue or note; it is the facts, and YOU decide what the music is.',
            path: a => `/film/music-sessions/${a.session_id}/brief`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_session_drift', handler: H, method: 'GET',
            description: 'Free; writes nothing. Whether the script or the picture moved since the session was stamped, and which side. A session that reads as drifted was written against something that no longer exists — say so before generating; rebase only when the director agrees.',
            path: a => `/film/music-sessions/${a.session_id}/drift`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_session_update', handler: H, method: 'PUT',
            description: 'Changes a session: name, notes, sample rate, frame rate, tempo map, or its lifecycle status. Status moves through the contract (draft → arranging → review → approved; approved can be reopened) and an illegal move is refused naming both states. Merged, not replaced.',
            path: a => `/film/music-sessions/${a.session_id}`, body: dropIds('session_id'),
            schema: { ...S, sequence_id: { type: 'string' }, scene_id: { type: 'string' },
                ...musicSchemaFor('film_music_sessions', ['sequence_id', 'scene_id', 'script_id']) },
            required: ['session_id'],
        },
        {
            name: 'music_session_delete', handler: H, method: 'DELETE',
            description: 'Deletes a score session and everything arranged in it: tracks, clips, ranges, markers, automation and the operation lineage. Registered audio assets are NOT deleted — they cost money and are referenced by clips, never owned by them.',
            path: a => `/film/music-sessions/${a.session_id}`, body: () => ({}), schema: S, required: ['session_id'],
        },
        {
            name: 'music_session_rebase', handler: H, method: 'POST',
            description: 'The explicit rebase: stamps the session with the brief as it stands now, so drift clears. Writes the fingerprints and the script version; changes no music. Do this only after the director has accepted that the score will be judged against the new picture and script.',
            path: a => `/film/music-sessions/${a.session_id}/rebase`, body: () => ({}), schema: S, required: ['session_id'],
        },
        {
            name: 'music_session_batch', handler: H, method: 'POST',
            description: 'Applies an ORDERED list of child edits in one transaction: ops of { op: create|update|delete, kind: tracks|clips|markers|emotion-ranges|automation, id?, data? }. "$n" in an id or a data value names the id produced by op n, so a track and the clips on it are written together. Any refusal rolls back everything and names the op by failed_at.',
            path: a => `/film/music-sessions/${a.session_id}/batch`, body: a => ({ ops: a.ops }),
            schema: { ...S, ops: { type: 'array', description: 'The ops, in order. Each: { op, kind, id (update/delete), data (create/update) }.' } },
            required: ['session_id', 'ops'],
        },
    ];
    tools.push({
        name: 'music_stem_import', handler: H, method: 'POST',
        description: 'Imports one or several composer stems into a score session, ALIGNED: every file lands as its own track and clip at the same start_ms with source_offset_ms 0, so leading silence is never trimmed — the alignment IS the leading silence. The bytes decide the format (WAV/BWF, AIFF, FLAC, MP3, M4A; the name is not trusted), the original is stored byte-identical and hashed, and duration, channels, sample rate, bit depth and codec are read from the file. BPM and key are read from tags or the filename as HINTS. normalize_48k writes a 48 kHz 24-bit working copy beside the original and records the resampling (a lossless file already at 48 kHz gets none). Writes one import operation, the assets, a rights row per file (status unknown unless declared) and the tracks and clips, in one transaction: one unreadable file refuses the whole batch and nothing is written. Spends nothing — no provider is called.',
        path: a => `/film/music-sessions/${a.session_id}/stems`, body: dropIds('session_id'),
        schema: {
            ...S,
            files: { type: 'array', description: 'The stems, in the order their tracks should appear. Each: { name: "drums.wav", data: "data:audio/wav;base64,…", role?: "drums" }. Sniffed by bytes; a name that lies is corrected.' },
            start_ms: { type: 'integer', minimum: 0, description: 'Where every stem starts in the session clock. Default 0. One number for the whole batch: aligned stems share a start.' },
            normalize_48k: { type: 'boolean', description: 'Also write a 48 kHz / 24-bit PCM working copy per stem, with lineage. The clip then plays the working copy; the original stays untouched.' },
            rights: { type: 'object', description: `Who owns these and on what terms: { status: ${musicStems.RIGHTS_STATUSES.join('|')}, owner, source, license_url, territory, expires_on, restrictions, notes }. Omitted is recorded as status "unknown" — never assumed cleared.` },
        },
        required: ['session_id', 'files'],
    });
    tools.push(
        {
            name: 'music_emotion_brief', handler: H, method: 'GET',
            description: 'Free — spends nothing. Everything needed to propose the emotional arc of a score session: the ScoreBrief (the shots with real timings and cameras, the exact screenplay passages, the cast, the look, the cues written), the arc a person has already accepted, the proposals still waiting, the range schema with the exact bounds the database enforces, the coverage rule and the instructions. YOU are the model: read it, decide the arc, then write it with music_emotion_propose. No tool here calls a server-side model.',
            path: a => `/film/music-sessions/${a.session_id}/emotion/brief`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_emotion_propose', handler: H, method: 'POST',
            description: 'Writes your proposed emotional arc as time ranges — each with start_ms, end_ms, a label a composer can act on, valence (−1..1), arousal (0..1), intensity (0..1), confidence (0..1) and a RATIONALE naming what in the picture or screenplay earns it (a range with no rationale is refused). Ranges must not overlap, must sit inside the picture and must cover most of it; bounds and coverage are validated with the field named. Stored as PROPOSED, source ai_proposal, under one proposal id; NOT accepted — nothing paid rests on a proposal until a person accepts it with music_emotion_accept. A new proposal supersedes the last one\'s still-proposed ranges and leaves accepted ones alone. Read music_emotion_brief first.',
            path: a => `/film/music-sessions/${a.session_id}/emotion/proposals`, body: dropIds('session_id'),
            schema: { ...S,
                ranges: { type: 'array', description: 'The ranges, in order: [{ start_ms, end_ms, label, valence, arousal, intensity, confidence, rationale }].' },
                model: { type: 'string', description: 'Which model reasoned — recorded on the operation.' },
                notes: { type: 'string', description: 'Anything about the arc as a whole.' } },
            required: ['session_id', 'ranges'],
        },
        {
            name: 'music_emotion_proposals', handler: H, method: 'GET',
            description: 'Free. Every emotion proposal made for a session, newest first: its ranges with what became of each (proposed, accepted, rejected), its coverage, which proposal it superseded, and which is current.',
            path: a => `/film/music-sessions/${a.session_id}/emotion/proposals`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_emotion_accept', handler: H, method: 'POST',
            description: 'The explicit acceptance — a person\'s decision, never the model\'s default: moves the named ranges of a proposal (all of its proposed ranges when range_ids is omitted) from proposed to accepted, applying edits on the way in (edits: { <range_id>: { label, valence, arousal, intensity, confidence, start_ms, end_ms, rationale } }), and rejects the rest when reject_rest is true. An edit outside the bounds refuses the whole acceptance naming the field. Only accepted ranges reach the brief, the bounce and generation. Call this only when the director has said so.',
            path: a => `/film/music-sessions/${a.session_id}/emotion/proposals/${a.proposal_id}/accept`, body: dropIds('session_id', 'proposal_id'),
            schema: { ...S, proposal_id: { type: 'string' },
                range_ids: { type: 'array', description: 'Which ranges to accept; all of the proposal\'s proposed ranges when omitted.' },
                edits: { type: 'object', description: 'Corrections per range id, applied as they are accepted.' },
                reject_rest: { type: 'boolean', description: 'Retire the proposal\'s other still-proposed ranges.' } },
            required: ['session_id', 'proposal_id'],
        },
        {
            name: 'music_bounce_plan', handler: H, method: 'GET',
            description: 'Free — writes nothing, renders nothing. What a bounce of this session WOULD do: the audible clips with their resolved gain, pan, fades, loop and automation, every clip left out with its reason (muted, another track soloed, take not selected, a reference track), the delivery stems the chosen mode would group, the fingerprint, the version it would become, and whether the session is unchanged since the last render. Read it before bouncing.',
            path: a => `/film/music-sessions/${a.session_id}/bounce/plan${a.stems ? '?stems=' + encodeURIComponent(a.stems) : ''}`,
            schema: { ...S, stems: { type: 'string', enum: musicRenderer.STEM_MODES, description: 'How to group the delivery stems: none (master only), instrument (one per track), family (one per family track the sources route to), bus (one per production bus).' } },
            required: ['session_id'],
        },
        {
            name: 'music_bounce', handler: H, method: 'POST',
            description: 'The deterministic bounce: renders the session\'s selected takes, with track and clip gain, pan, fades, loops and gain/mute automation, into a 48 kHz / 24-bit stereo MASTER plus the chosen delivery stems (equal length, one file each), through the local encoder — spends nothing at any provider. Every output is registered as an asset with the render parameters and the operation that made it; earlier versions are kept, never overwritten. A session unchanged since its last bounce is refused (409, UNCHANGED) unless force is true, so the same inputs are not rendered twice by accident. Refused, with the clip named, when a clip\'s file is missing.',
            path: a => `/film/music-sessions/${a.session_id}/bounce`, body: dropIds('session_id'),
            schema: { ...S,
                stems: { type: 'string', enum: musicRenderer.STEM_MODES, description: 'none (master only), instrument, family or bus.' },
                force: { type: 'boolean', description: 'Render again even though nothing changed since the last bounce; the result is a new version that supersedes it.' } },
            required: ['session_id'],
        },
        {
            name: 'music_separate_plan', handler: H, method: 'GET',
            description: 'Free — spends nothing, writes nothing. What separating a clip of a score session WOULD do: the project\'s music provider, the variation (2 stems: vocals + instrumental; 6 stems: vocals, drums, bass, guitar, piano, other), the stems expected back, the recording that would be sent and its length, the placement every stem will take (the source clip\'s own start, offset and length), and a cost hint from the rate book. Refused with the reason when the provider cannot separate, the clip has no audio, or the file is missing. Read it before music_separate.',
            path: a => `/film/music-sessions/${a.session_id}/separations/plan?clip_id=${encodeURIComponent(a.clip_id)}&stems=${encodeURIComponent(a.stems)}${a.output_format ? '&output_format=' + encodeURIComponent(a.output_format) : ''}`,
            schema: { ...S, clip_id: { type: 'string', description: 'The clip whose recording would be separated.' },
                stems: { type: 'integer', enum: Object.keys(musicSeparation.VARIATIONS).map(Number), description: 'How many stems: 2 or 6.' },
                output_format: { type: 'string', description: 'mp3_<rate>_<kbps>; default mp3_44100_128.' } },
            required: ['session_id', 'clip_id', 'stems'],
        },
        {
            name: 'music_separate', handler: H, method: 'POST',
            description: 'COSTS MONEY — sends a clip\'s recording to the project\'s music provider to be split into two or six stems (2: vocals + instrumental; 6: vocals, drums, bass, guitar, piano, other). The result is a DERIVATIVE: each returned stem becomes one asset (with lineage to the source and the operation), one track with a role, and one clip placed exactly where the source clip sits; the source recording, its asset and its clip are never touched, and the stems carry the source\'s rights. Answers at once with a running operation (wait: true to block until it finishes); read it with music_separation_status. A bad archive, a provider error or a stem that cannot be read leaves the operation failed with the reason and NOTHING registered — retry it with music_separation_retry. Read music_separate_plan first, and ask before spending.',
            path: a => `/film/music-sessions/${a.session_id}/separations`, body: dropIds('session_id'),
            schema: { ...S, clip_id: { type: 'string', description: 'The clip whose recording is separated.' },
                stems: { type: 'integer', enum: Object.keys(musicSeparation.VARIATIONS).map(Number), description: 'How many stems: 2 or 6.' },
                output_format: { type: 'string', description: 'mp3_<rate>_<kbps>; default mp3_44100_128.' },
                wait: { type: 'boolean', description: 'Block until the separation has finished rather than answering with a running operation.' } },
            required: ['session_id', 'clip_id', 'stems'],
        },
        {
            name: 'music_separation_status', handler: H, method: 'GET',
            description: 'Free. One separation: running, complete (with each stem\'s asset, track, clip and served url, and any warnings about stems that were not the ones expected) or failed (with the reason). Nothing is re-sent.',
            path: a => `/film/music-sessions/${a.session_id}/separations/${a.operation_id}`,
            schema: { ...S, operation_id: { type: 'string' } }, required: ['session_id', 'operation_id'],
        },
        {
            name: 'music_separation_list', handler: H, method: 'GET',
            description: 'Free. Every separation of a session, newest first, with its status, stems or failure, and the retry it came from.',
            path: a => `/film/music-sessions/${a.session_id}/separations`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_separation_retry', handler: H, method: 'POST',
            description: 'COSTS MONEY — tries a FAILED separation again as a new operation whose parent names the failed one (the failure stays in the lineage). Only a failed separation can be retried; a complete one is refused. Ask before spending.',
            path: a => `/film/music-sessions/${a.session_id}/separations/${a.operation_id}/retry`, body: dropIds('session_id', 'operation_id'),
            schema: { ...S, operation_id: { type: 'string' }, wait: { type: 'boolean', description: 'Block until the retry has finished.' } },
            required: ['session_id', 'operation_id'],
        },
        {
            name: 'music_generate_plan', handler: H, method: 'POST',
            description: 'Free — spends nothing, writes nothing. What a generation on a score session WOULD do, for any of the five generating workflows: the project\'s music provider and model (or that provider\'s own reason it cannot, e.g. no native parts or no inpainting), the length, how many outputs and of what kind (a whole cue, native parts, an inpainted range — never mistaken for separated stems), the context sent (session tempo and meter, your key, the ACCEPTED emotional arc — never a proposal — and the arc as composition sections where the provider takes them), the cost hint, and the take behaviour. Refuses EMOTION_NOT_ACCEPTED when no arc is accepted unless ignore_emotion. Read it before music_generate.',
            path: a => `/film/music-sessions/${a.session_id}/generate/plan`, body: dropIds('session_id'),
            schema: { ...S,
                workflow: { type: 'string', enum: musicGeneration.GENERATE_WORKFLOWS.slice(), description: 'music_compose (a whole cue), music_parts (the provider\'s native parts), music_reference (conditioned on an audio or melody reference), music_video (conditioned on the picture), music_inpaint (a range of an existing clip regenerated in context).' },
                prompt: { type: 'string', description: 'The musical direction, in words. The session\'s tempo, meter, the key you give and the ACCEPTED emotional arc are added.' },
                duration_ms: { type: 'integer', minimum: 1, description: 'Length to make; defaults to the picture the session covers. Not used by inpaint.' },
                key: { type: 'string', description: 'The key, e.g. "D minor".' },
                tempo_bpm: { type: 'number', description: 'Overrides the session\'s opening tempo.' },
                model: { type: 'string', description: 'One of the provider\'s music models.' },
                track_id: { type: 'string', description: 'Land the take on this track (as a candidate beside what it holds); a new track when omitted.' },
                start_ms: { type: 'integer', minimum: 0, description: 'Where the take starts on the session clock. Default 0.' },
                parts: { type: 'array', description: 'music_parts: the parts wanted, by role (e.g. ["strings","drums"]).' },
                reference_asset_id: { type: 'string', description: 'music_reference: the audio asset to condition on.' },
                reference_kind: { type: 'string', description: 'music_reference: audio or melody.' },
                video_asset_id: { type: 'string', description: 'music_video: the clip or the conformed film.' },
                clip_id: { type: 'string', description: 'music_inpaint: the clip whose range is regenerated; it is kept.' },
                range: { type: 'object', description: 'music_inpaint: { start_ms, end_ms } measured inside the clip.' },
                ignore_emotion: { type: 'boolean', description: 'Generate with no accepted arc. Without it an unaccepted arc refuses (EMOTION_NOT_ACCEPTED).' } },
            required: ['session_id', 'workflow'],
        },
        {
            name: 'music_generate', handler: H, method: 'POST',
            description: 'COSTS MONEY — generates music on a score session with the project\'s provider: a whole cue, native parts, a reference- or picture-conditioned cue, or an inpainted range. Every output is a NEW file, asset and clip — a candidate take beside what a track already holds (selected only on a new track), labelled by kind; nothing on the session is replaced and every earlier take is kept. The session\'s tempo, meter, your key and the accepted emotional arc travel with the request. A provider error or bytes that are not audio leave a failed operation and nothing registered. Read music_generate_plan first, and ask before spending.',
            path: a => `/film/music-sessions/${a.session_id}/generate`, body: dropIds('session_id'),
            schema: { ...S,
                workflow: { type: 'string', enum: musicGeneration.GENERATE_WORKFLOWS.slice(), description: 'music_compose (a whole cue), music_parts (the provider\'s native parts), music_reference (conditioned on an audio or melody reference), music_video (conditioned on the picture), music_inpaint (a range of an existing clip regenerated in context).' },
                prompt: { type: 'string', description: 'The musical direction, in words. The session\'s tempo, meter, the key you give and the ACCEPTED emotional arc are added.' },
                duration_ms: { type: 'integer', minimum: 1, description: 'Length to make; defaults to the picture the session covers. Not used by inpaint.' },
                key: { type: 'string', description: 'The key, e.g. "D minor".' },
                tempo_bpm: { type: 'number', description: 'Overrides the session\'s opening tempo.' },
                model: { type: 'string', description: 'One of the provider\'s music models.' },
                track_id: { type: 'string', description: 'Land the take on this track (as a candidate beside what it holds); a new track when omitted.' },
                start_ms: { type: 'integer', minimum: 0, description: 'Where the take starts on the session clock. Default 0.' },
                parts: { type: 'array', description: 'music_parts: the parts wanted, by role (e.g. ["strings","drums"]).' },
                reference_asset_id: { type: 'string', description: 'music_reference: the audio asset to condition on.' },
                reference_kind: { type: 'string', description: 'music_reference: audio or melody.' },
                video_asset_id: { type: 'string', description: 'music_video: the clip or the conformed film.' },
                clip_id: { type: 'string', description: 'music_inpaint: the clip whose range is regenerated; it is kept.' },
                range: { type: 'object', description: 'music_inpaint: { start_ms, end_ms } measured inside the clip.' },
                ignore_emotion: { type: 'boolean', description: 'Generate with no accepted arc. Without it an unaccepted arc refuses (EMOTION_NOT_ACCEPTED).' } },
            required: ['session_id', 'workflow'],
        },
        {
            name: 'music_generation_list', handler: H, method: 'GET',
            description: 'Free. Every generation on a session, newest first: the workflow, provider and model, the context that was sent, each output with its asset, track, clip and take status, or the failure.',
            path: a => `/film/music-sessions/${a.session_id}/generations`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_job_list', handler: H, method: 'GET',
            description: 'Free. Every generation and separation on a score session as one PARENT job with its ordered CHILD outputs: each child\'s provider, model and provider job id, cost, attempt, source and context fingerprints, take number and acceptance (read from the take itself: accepted, pending, rejected). A parent\'s status is derived from its children — it is complete only when every expected output is — and a stored status that disagrees is flagged.',
            path: a => `/film/music-sessions/${a.session_id}/jobs`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_job_get', handler: H, method: 'GET',
            description: 'Free. One job with its children and the reason when it failed, naming the child.',
            path: a => `/film/music-sessions/${a.session_id}/jobs/${a.operation_id}`,
            schema: { ...S, operation_id: { type: 'string' } }, required: ['session_id', 'operation_id'],
        },
        {
            name: 'music_job_poll', handler: H, method: 'POST',
            description: 'Free — spends nothing. Where a job has got to. A job still marked running that no process owns any more (the server restarted mid-run) is reported INTERRUPTED and its open outputs failed, so it can be retried instead of reading as running for ever.',
            path: a => `/film/music-sessions/${a.session_id}/jobs/${a.operation_id}/poll`, body: dropIds('session_id', 'operation_id'),
            schema: { ...S, operation_id: { type: 'string' } }, required: ['session_id', 'operation_id'],
        },
        {
            name: 'music_job_retry', handler: H, method: 'POST',
            description: 'COSTS MONEY — runs a FAILED job again (a generation with the input it recorded, or a separation of the same clip) as the next attempt, whose parent names the attempt it retries. A running or complete job is refused. Ask before spending.',
            path: a => `/film/music-sessions/${a.session_id}/jobs/${a.operation_id}/retry`, body: dropIds('session_id', 'operation_id'),
            schema: { ...S, operation_id: { type: 'string' }, wait: { type: 'boolean', description: 'Separation only: block until the retry has finished.' } },
            required: ['session_id', 'operation_id'],
        },
        {
            name: 'music_package_build', handler: H, method: 'POST',
            description: 'Spends nothing — no provider is called; at most the session is rendered locally. Builds the portable, DAW-neutral score package: a versioned manifest (session and operation ids, frame and sample rates, tempo and time-signature map, markers, track and clip placement, accepted emotional arc, rights, provenance, hashes and round-trip matching keys) beside equal-length 48 kHz / 24-bit Broadcast WAV stems aligned at the session start, the master, and the reference picture when the film has a conformed master. Deterministic: an unchanged session builds the same bytes and the existing package is returned.',
            path: a => `/film/music-sessions/${a.session_id}/package`, body: dropIds('session_id'),
            schema: { ...S, include_picture: { type: 'boolean', description: 'Carry the conformed film as the reference picture (default true; over 256 MB it is identified by hash instead).' } },
            required: ['session_id'],
        },
        {
            name: 'music_package_list', handler: H, method: 'GET',
            description: 'Free. Every score package built from a session, newest first, with its hash, size, stem count and served url.',
            path: a => `/film/music-sessions/${a.session_id}/packages`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_package_validate', handler: H, method: 'POST',
            description: 'Free — writes nothing. Checks a score package: the format and version, every manifest section, every listed file present with its hash and size, nothing unlisted, and every stem a WAV at the package\'s sample rate and exactly its length. Answers the verdict with each problem named.',
            path: a => `/film/projects/${a.project_id}/music-packages/import`, body: a => ({ ...dropIds('project_id')(a), validate_only: true }),
            schema: { project_id: { type: 'string' }, asset_id: { type: 'string', description: 'A package already on this machine.' }, data: { type: 'string', description: 'Or the archive itself, as a data URI or base64.' } },
            required: ['project_id'],
        },
        {
            name: 'music_package_import', handler: H, method: 'POST',
            description: 'Imports a score package — a Film Engine one, or one returned from a DAW with its keys intact. Validated first; a refusal writes nothing. Into session_id (a round trip) every stem finds its track by its matching key and lands as a CANDIDATE take beside what the track holds, never over it; a key whose track is gone gets a new track. Without session_id a new session is made with the tempo map, markers and accepted arc restored and every stem aligned at the start. Stems are stored byte-identical with their hashes and rights.',
            path: a => `/film/projects/${a.project_id}/music-packages/import`, body: dropIds('project_id'),
            schema: { project_id: { type: 'string' }, asset_id: { type: 'string' }, data: { type: 'string', description: 'The archive as a data URI or base64.' },
                session_id: { type: 'string', description: 'Import back into this session: matched stems land as candidate takes.' } },
            required: ['project_id'],
        },
        // ── Ableton, through the DAW contract (MUS-018) ─────────────────────
        // One tool per operation of DAW_OPERATIONS (lib/daw-registry.js holds
        // the map). None takes an OSC address or a Live property: the most an
        // agent reaches is the sidecar's allowlist, through the driver's rules.
        {
            name: 'ableton_status', handler: H, method: 'GET',
            description: 'Free — changes nothing. Is Ableton Live reachable through the local sidecar, which Live version answered, and is it the reviewed one (12.4; AbletonOSC cannot report the 12.4.5 bugfix). A Live that is not the reviewed version can be read and cannot be changed. Unconfigured, it says what to set and where the setup guide is.',
            path: () => '/film/daw/ableton/status', schema: {}, required: [],
        },
        {
            name: 'ableton_session_read', handler: H, method: 'GET',
            description: 'Free — changes nothing. The Live set as it is: every track with its owner (film-engine for a track carrying a Film Engine marker ⟨fe:…⟩, live for everything else), its revision and the tempo. Read before planning a push.',
            path: () => '/film/daw/ableton/session', schema: {}, required: [],
        },
        {
            name: 'ableton_score_push_plan', handler: H, method: 'GET',
            description: 'Free — changes nothing in Live; at most builds the portable score package locally. What pushing this score session to Ableton would do: the Film Engine tracks it would create and update, the tracks that are not Film Engine\'s and are left alone, every conflict (a Film Engine track edited in Live since the last push), and a plan_fingerprint to push exactly this plan.',
            path: a => `/film/music-sessions/${a.session_id}/daw/ableton/push/plan`, schema: S, required: ['session_id'],
        },
        {
            name: 'ableton_score_push', handler: H, method: 'POST',
            description: 'Changes Live — carries out a push plan into Film Engine\'s own tracks in the Live set (created at the end, named with their ⟨fe:…⟩ marker; nothing else in the set is touched) and sets the song tempo. Pass the plan_fingerprint from ableton_score_push_plan; a plan the session or Live has moved past is refused (STALE_PLAN), and every conflict must be decided (overwrite or keep_daw) first. Idempotent: the same plan pushed again returns the recorded result without reaching Live. AbletonOSC cannot place audio from a file, so each acknowledged track names the stem a person drags in at bar 1.1.1. Spends no provider credits.',
            path: a => `/film/music-sessions/${a.session_id}/daw/ableton/push`, body: dropIds('session_id'),
            schema: { ...S, plan_fingerprint: { type: 'string', description: 'From ableton_score_push_plan.' },
                resolutions: { type: 'object', description: 'fe_key → "overwrite" or "keep_daw", one per conflict in the plan.' },
                idempotency_key: { type: 'string', description: 'Retry a push whose outcome is unknown (a timeout) with the key it reported; it cannot apply twice.' } },
            required: ['session_id', 'plan_fingerprint'],
        },
        {
            name: 'ableton_mix_pull_plan', handler: H, method: 'GET',
            description: 'Free — changes nothing. What Live has rendered that could come back into the session, with hashes, and which already has. AbletonOSC exports no render, so from Live this is empty with the reason: export stems from Live and bring them back with music_package_import.',
            path: a => `/film/music-sessions/${a.session_id}/daw/ableton/pull/plan`, schema: S, required: ['session_id'],
        },
        {
            name: 'ableton_mix_pull', handler: H, method: 'POST',
            description: 'Changes the session, not Live — brings one render back from Live as an immutable package, imported only after its sha256 hash matches what was advertised and every stem is aligned, landing as CANDIDATE takes beside what the tracks hold. Idempotent per render hash. From Ableton this is refused with the reason (AbletonOSC exports nothing in Live); use music_package_import for stems exported by hand.',
            path: a => `/film/music-sessions/${a.session_id}/daw/ableton/pull`, body: dropIds('session_id'),
            schema: { ...S, item_id: { type: 'string', description: 'From ableton_mix_pull_plan.' }, idempotency_key: { type: 'string' } },
            required: ['session_id', 'item_id'],
        },
        {
            name: 'ableton_transport', handler: H, method: 'POST',
            description: 'Changes Live\'s transport — play, stop, or locate to a position in milliseconds (converted to beats at Live\'s tempo). Supervised: pass supervised: true ONLY when a person asked for it in this conversation; an agent never starts or moves Live on its own, and without it the call is refused. Recorded in the session\'s audit.',
            path: a => `/film/music-sessions/${a.session_id}/daw/ableton/transport`, body: dropIds('session_id'),
            schema: { ...S, command: { type: 'string', enum: ['play', 'stop', 'locate'] }, position_ms: { type: 'integer', minimum: 0, description: 'locate only.' },
                supervised: { type: 'boolean', description: 'true only when a person asked for this.' } },
            required: ['session_id', 'command'],
        },
        {
            name: 'music_session_approve', handler: H, method: 'POST',
            description: 'Spends nothing. Approves a score session by SELECTING a bounce as its mix — the newest complete one, or bounce_operation_id. Only a session in review (or already approved, to reselect) can be approved, and a bounce rendered before the session last changed is refused as STALE_MIX (ignore_stale overrides). From then on the timeline, playback, audio mix, pipeline, NLE exports and the conformed master consume that one mix at the start of the session\'s picture, and the scene music under it is dropped. Only a person\'s decision should drive this: ask before approving.',
            path: a => `/film/music-sessions/${a.session_id}/approve`, body: dropIds('session_id'),
            schema: { ...S, bounce_operation_id: { type: 'string', description: 'Which bounce to approve (from music_bounce_list); default the newest complete one.' },
                ignore_stale: { type: 'boolean', description: 'Approve a bounce made before the session last changed.' },
                ignore_rights: { type: 'boolean', description: 'Approve over a rights block (recorded). Only when a person decided to.' } },
            required: ['session_id'],
        },
        {
            name: 'music_session_unapprove', handler: H, method: 'POST',
            description: 'Spends nothing. Takes an approval back: the session returns to review, its mix is no longer consumed by anything, and the scene music it replaced comes back.',
            path: a => `/film/music-sessions/${a.session_id}/unapprove`, body: dropIds('session_id'), schema: S, required: ['session_id'],
        },
        {
            name: 'music_score_lineage', handler: H, method: 'GET',
            description: 'Free. Every clip of a score session and its mix (the approved one, else the current bounce), each walked to its sources: origin (original, generated, licensed, public_domain, unknown — or derived from its sources), rights status (a derivative carries the most encumbered of its sources), owner, provider, model, operation and hash. Names every issue and the rights policy in force at approval and final export. Nothing is assigned: a generated file is generated, not cleared.',
            path: a => `/film/music-sessions/${a.session_id}/lineage`, schema: S, required: ['session_id'],
        },
        {
            name: 'music_health', handler: H, method: 'GET',
            description: 'Free. The score workstation\'s operations, by area — render (bounces), generation, separation, package, DAW push/pull, stem import, records — with counts per status, what is running, what is STALLED (a job no process owns, or a render running far past its ceiling) and the recent failures, each with its session and how to recover. Also whether the encoder is available (and where it came from) and, per DAW adapter, whether it is configured and why not; probe: true also asks each configured DAW whether it answers. Scope with project_id or session_id. Nothing in it carries a token, a key or an absolute path: error text is kept with paths cut to their file names.',
            path: a => `/film/music-sessions/health${(() => { const q = ['project_id', 'session_id'].filter(k => a[k]).map(k => `${k}=${encodeURIComponent(a[k])}`); if (a.probe) q.push('probe=true'); return q.length ? `?${q.join('&')}` : ''; })()}`,
            schema: { project_id: { type: 'string' }, session_id: { type: 'string' }, probe: { type: 'boolean', description: 'Also ask each configured DAW whether it answers (a network call with a short ceiling).' } },
            required: [],
        },
        {
            name: 'music_score_report', handler: H, method: 'GET',
            description: 'Free. Which approved score mixes the film consumes and where each sits on the timeline, and every session that is not consumed and why: unapproved, stale (still used, but the session or the picture moved since), missing (no mix or no file), unplaced, overlapping another approved session, or shadowed by a finished project mix.',
            path: a => `/film/projects/${a.project_id}/music-score`, schema: { project_id: { type: 'string' } }, required: ['project_id'],
        },
        {
            name: 'music_daw_audit', handler: H, method: 'GET',
            description: 'Free — needs no DAW connection. Every push, pull and transport a session has sent to a DAW, newest first: the operation, request id, idempotency key, outcome, duration and the error when it failed. A failed push whose outcome is unknown (a timeout) says so and names the key to retry it with.',
            path: a => `/film/music-sessions/${a.session_id}/daw/${a.adapter || 'ableton'}/audit`,
            schema: { ...S, adapter: { type: 'string', description: 'Which DAW adapter (default ableton).' } }, required: ['session_id'],
        },
        {
            name: 'music_bounce_list', handler: H, method: 'GET',
            description: 'Free. Every bounce of a session, newest version first: status, fingerprint, what it superseded, the master and each stem with its served url, what was left out and why. The newest complete one is marked current.',
            path: a => `/film/music-sessions/${a.session_id}/bounces`, schema: S, required: ['session_id'],
        },
    );
    tools.push({
        name: 'music_track_render', handler: H, method: 'POST',
        description: 'FREE \u2014 it runs on this machine and no provider is billed. Play a score track\u2019s own '
            + 'notes through its own instrument, and land the audio as a take in that track\u2019s lane. THIS IS '
            + 'WHERE A SCORE IS COMPOSED from the director\u2019s own sample libraries: give a track notes '
            + '(music_track_update with notes: { program, notes: [{ start_ms, duration_ms, pitch, velocity }] }) and '
            + 'an instrument_id from instrument_list, then play it. On a track that already holds a take the new one '
            + 'arrives as a CANDIDATE, so what plays keeps playing until somebody selects it. A render that comes '
            + 'back silent is refused rather than kept, and a refusal names its stage.',
        path: a => `/film/music-sessions/${a.session_id}/tracks/${a.track_id}/render`,
        body: () => ({}),
        schema: { ...S, track_id: { type: 'string', description: 'The track to play, from music_track_list.' } },
        required: ['session_id', 'track_id'],
    });

    for (const [kind, spec] of Object.entries(MUSIC_KINDS)) {
        const one = MUSIC_SINGULAR[kind];
        const idArg = `${one}_id`;
        const what = MUSIC_WHAT[kind];
        const fields = musicSchemaFor(spec.table, ['session_id']);
        const paths = MUSIC_PATHS[kind];
        if (!paths) throw new Error(`mcp-tools: no path builders for music child kind '${kind}'`);
        const kindPath = paths.list;
        const itemPath = paths.item;
        tools.push(
            {
                name: `music_${one}_list`, handler: H, method: 'GET',
                description: `Free. The ${kind.replace('-', ' ')} of a session, each ${what.split(':')[0]}.`,
                path: kindPath, schema: S, required: ['session_id'],
            },
            {
                name: `music_${one}_create`, handler: H, method: 'POST',
                description: `Creates ${what}. Validated against the same vocabulary the database enforces; a refusal names the field. Writes one row; spends nothing.`,
                path: kindPath, body: dropIds('session_id'),
                schema: { ...S, ...fields }, required: ['session_id', ...(spec.owner === 'track' ? ['track_id'] : [])],
            },
            {
                name: `music_${one}_update`, handler: H, method: 'PUT',
                description: `Changes ${kind === 'emotion-ranges' ? 'an emotion range' : `a ${one}`}: ${what.split(':')[0]}. Merged, not replaced, so one field can be corrected without restating the rest. A row that belongs to another session is not found.`,
                path: itemPath, body: dropIds('session_id', idArg),
                schema: { ...S, [idArg]: { type: 'string' }, ...fields }, required: ['session_id', idArg],
            },
            {
                name: `music_${one}_delete`, handler: H, method: 'DELETE',
                description: `Deletes ${kind === 'emotion-ranges' ? 'an emotion range' : `a ${one}`} from its session${kind === 'tracks' ? ', and the clips and automation on it' : ''}. Removes the arrangement row only; any asset it referenced stays registered.`,
                path: itemPath, body: () => ({}), schema: { ...S, [idArg]: { type: 'string' } }, required: ['session_id', idArg],
            },
        );
    }
    return tools;
}
PRODUCTION_TOOLS.push(...musicSessionTools());

/*
 * `route` names the router function each flow tool reaches, for the test that
 * holds every shipped route to a tool. It is NOT `handler`: dispatch passes
 * `handler` to callRoute as a function, and a string there broke every flow
 * tool at call time.
 */
const ROUTE_TOOLS = [
    {
        name: 'flow_list',
        route: 'listFlows',
        method: 'GET',
        description: 'List the flows a project can use — its own plus every library flow. Start here.',
        path: a => `/film/projects/${a.project_id}/flows`,
        schema: { project_id: { type: 'string' } },
        required: ['project_id'],
        probe: { project_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_get',
        route: 'getFlow',
        method: 'GET',
        description: 'Read one flow: its nodes, its edges and their typed ports.',
        path: a => `/film/flows/${a.flow_id}`,
        schema: { flow_id: { type: 'string' } },
        required: ['flow_id'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_create',
        route: 'createFlow',
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
        route: 'updateFlow',
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
        route: 'deleteFlow',
        method: 'DELETE',
        description: 'Delete a flow. Built-in flows cannot be deleted.',
        path: a => `/film/flows/${a.flow_id}`,
        schema: { flow_id: { type: 'string' } },
        required: ['flow_id'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_validate',
        route: 'validateFlow',
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
        route: 'estimateFlow',
        method: 'POST',
        description: 'Projected cost and generation-call count for a run, against the project budget. The budget gate uses this, so check it before flow_run on any fan-out.',
        path: a => `/film/flows/${a.flow_id}/estimate`,
        schema: { flow_id: { type: 'string' }, project_id: { type: 'string' } },
        required: ['flow_id'],
        bodyKeys: ['project_id'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_apply_plan',
        route: 'applyPlanRoute',
        method: 'GET',
        description: 'FREE — spends nothing. Plan applying a flow to a selection of Production-graph nodes: pass their keys (shot:<id>, seq:<id>; a sequence expands to its shots). '
            + 'Returns, per shot, what each of the flow\'s input nodes binds to (in.scene the shot\'s card, in.subject its first character unless the node names one) or why the shot is refused; '
            + 'clips, sounds, sound versions and borrowed-frame links are refused with where to apply instead; held shots are named and left out. '
            + 'Prices every run from the flow\'s own projection (fan-out multiplied), totals the selection, answers the project budget, and returns a fingerprint the apply will require.',
        path: a => {
            const keys = Array.isArray(a.targets) ? a.targets.join(',') : String(a.targets || '');
            const q = new URLSearchParams({ targets: keys });
            if (a.project_id) q.set('project_id', a.project_id);
            if (a.vars) q.set('vars', JSON.stringify(a.vars));
            if (a.inputs) q.set('inputs', JSON.stringify(a.inputs));
            return `/film/flows/${a.flow_id}/apply-plan?${q.toString()}`;
        },
        schema: {
            flow_id: { type: 'string' },
            targets: { type: 'array', items: { type: 'string' }, description: 'Graph node keys: shot:<id>, seq:<id>. Read them from production_graph_get.' },
            project_id: { type: 'string', description: 'Required for a library flow; defaults to the flow\'s own project.' },
            vars: { type: 'object', description: 'Values for {{placeholders}} in the flow\'s prompt nodes.' },
            inputs: { type: 'object', description: 'The flow\'s form (flow_form): { input node id: value } for its EXPOSED inputs only — a prompt\'s text, an asset id, a subject name. They change what the plan binds and are part of its fingerprint.' },
        },
        required: ['flow_id', 'targets'],
        probe: { flow_id: 'probe-no-such-flow', targets: ['shot:probe'] },
    },
    {
        name: 'flow_form',
        route: 'formRoute',
        method: 'GET',
        description: 'FREE — spends nothing. A flow\'s form: its input nodes marked exposed, each as a field (text for a prompt, an asset picker with this project\'s assets, a subject picker with its characters, locations and props) with the node\'s own value as the default, and any exposed input that cannot be filled in with why. '
            + 'Pass the values as inputs to flow_apply_plan and then flow_apply.',
        path: a => `/film/flows/${a.flow_id}/form${a.project_id ? `?project_id=${encodeURIComponent(a.project_id)}` : ''}`,
        schema: {
            flow_id: { type: 'string' },
            project_id: { type: 'string', description: 'Which project\'s assets and subjects to offer; defaults to the flow\'s own project.' },
        },
        required: ['flow_id'],
        probe: { flow_id: 'probe-no-such-flow' },
    },
    {
        name: 'flow_apply',
        route: 'applyRoute',
        method: 'POST',
        description: 'Apply a flow to a selection of Production-graph nodes: one run per runnable shot, through the flow executor, tied by one apply record. GENERATES MEDIA AND SPENDS MONEY. '
            + 'Read flow_apply_plan first and pass its fingerprint with the SAME targets: a plan that moved since (flow, selection, a shot\'s card) is refused 409 PLAN_MOVED with the current plan, and nothing starts. '
            + 'Refused 402 over the project budget unless ignore_budget (say why to the user); refused 422 when nothing in the selection can run; refused 409 APPLY_IN_PROGRESS while the same plan is already running. '
            + 'Answers 202 at once with the apply id and its runs; read progress with flow_apply_get.',
        path: a => `/film/flows/${a.flow_id}/apply`,
        schema: {
            flow_id: { type: 'string' },
            targets: { type: 'array', items: { type: 'string' }, description: 'The same graph node keys the plan was read for.' },
            fingerprint: { type: 'string', description: 'flow_apply_plan\'s fingerprint.' },
            project_id: { type: 'string' },
            vars: { type: 'object' },
            inputs: { type: 'object', description: 'The same form values the plan was read with.' },
            ignore_budget: { type: 'boolean', description: 'Override the budget refusal. Say why in your message to the user.' },
        },
        required: ['flow_id', 'targets', 'fingerprint'],
        bodyKeys: ['targets', 'fingerprint', 'project_id', 'vars', 'inputs', 'ignore_budget'],
        probe: { flow_id: 'probe-no-such-flow', targets: ['shot:probe'], fingerprint: 'probe' },
    },
    {
        name: 'flow_apply_get',
        route: 'getApplyRoute',
        method: 'GET',
        description: 'FREE. One apply of a flow to a selection: its runs, one per shot, each with its status, and the apply\'s status derived from them (running, paused waiting for a pick, complete, completed_with_errors, failed, cancelled; interrupted when the process running it died).',
        path: a => `/film/flow-applies/${a.apply_id}`,
        schema: { apply_id: { type: 'string' } },
        required: ['apply_id'],
        probe: { apply_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_run',
        route: 'runFlowRoute',
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
        route: 'getRun',
        method: 'GET',
        description: 'A run with its per-node status, provider routing notes and the graph snapshot it actually ran.',
        path: a => `/film/flow-runs/${a.run_id}`,
        schema: { run_id: { type: 'string' } },
        required: ['run_id'],
        probe: { run_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_run_cancel',
        route: 'cancelRun',
        method: 'POST',
        description: 'Cancel an in-flight run. Nodes already running finish; nothing new starts.',
        path: a => `/film/flow-runs/${a.run_id}/cancel`,
        schema: { run_id: { type: 'string' } },
        required: ['run_id'],
        probe: { run_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_run_branches',
        route: 'getBranches',
        method: 'GET',
        description: 'Variants produced by a fan-out, for comparison at a select gate.',
        path: a => `/film/flow-runs/${a.run_id}/branches`,
        schema: { run_id: { type: 'string' } },
        required: ['run_id'],
        probe: { run_id: '00000000-0000-0000-0000-000000000000' },
    },
    {
        name: 'flow_run_select',
        route: 'selectBranch',
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
        route: 'createFromTemplate',
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
        name: 'image_upscale',
        description: 'Upscale one supplied PNG or JPEG to the 2K or 4K tier with MuAPI Topaz. SPENDS MuAPI credits. '
            + 'Uses Topaz Precision High Fidelity V3 at the smallest scale that reaches the target; a source too small '
            + 'for Precision\'s 4x ceiling automatically uses Topaz\'s compatible 8x endpoint. Returns the finished '
            + 'image inline and saves a durable copy under Film Engine data/upscaled.',
        schema: {
            image: { type: 'string', description: 'The source picture as data:image/png;base64,... or data:image/jpeg;base64,...' },
            resolution: { type: 'string', enum: ['2K', '4K'], description: 'The minimum long-edge delivery tier.' },
        },
        required: ['image', 'resolution'],
        async run(a) {
            return require('./providers/muapi-topaz-upscale').upscaleImage(a);
        },
    },
    {
        name: 'graph_hold',
        description: 'Hold or release a node by its graph key (shot:<id>, seq:<id>, sound:<id>): a held node is skipped by every '
            + 'batch run and said so, and stays in the film — conform and export never read the hold. FREE. Goes through the '
            + 'node’s own update route, exactly as shot_update / sequence_update / music_cue_update with `held` would.',
        schema: { node_key: { type: 'string' }, held: { type: 'boolean', description: 'true holds, false releases.' } },
        required: ['node_key', 'held'],
        async run(a) {
            const hold = require('./graph-hold');
            const [prefix, id] = String(a.node_key || '').split(':');
            const h = hold.HOLDABLE.find(x => x.key_prefix === prefix);
            if (!h || !id) return { error: `A ${prefix || 'node'} cannot be held; holdable: ${hold.HOLDABLE.map(x => x.key_prefix + ':<id>').join(', ')}` };
            const handler = require(`../routes/${h.route_module}`)[h.handler];
            return callRoute('PUT', h.path(id), { held: a.held }, handler);
        },
    },
    {
        name: 'version_select',
        description: 'Choose which version plays — a shot’s clip, a sequence’s clip, or a sound’s — by the version’s asset '
            + 'id (the id in its ver:<id> key); clear: true goes back to the ordinary rule. FREE: it moves a pointer, it '
            + 'generates nothing. Through the parent’s own select route.',
        schema: { asset_id: { type: 'string' }, clear: { type: 'boolean' } },
        required: ['asset_id'],
        async run(a) {
            const { db } = require('../db/database');
            const row = db.prepare('SELECT id, asset_type, shot_id, metadata FROM film_assets WHERE id = ?').get(a.asset_id);
            if (!row) return { error: 'No such version' };
            let meta = {};
            try { meta = JSON.parse(row.metadata || '{}') || {}; } catch (_) { meta = {}; }
            const method = a.clear ? 'DELETE' : 'POST';
            const body = { asset_id: row.id };
            if (/^audio_/.test(row.asset_type)) {
                const cue = meta.cue_id || meta.music_cue_id
                    || (db.prepare('SELECT id FROM film_music_cues WHERE generated_asset_id = ?').get(row.id) || {}).id;
                if (!cue) return { error: 'That sound belongs to no cue, so there is nothing to select it for' };
                return callRoute(method, `/film/music-cues/${cue}/select`, body, handleProductionGraph);
            }
            if (/^video_/.test(row.asset_type)) {
                if (meta.sequence_id) return callRoute(method, `/film/sequences/${meta.sequence_id}/video/select`, body, handleSequences);
                if (row.shot_id) return callRoute(method, `/film/shots/${row.shot_id}/video/select`, body, handleProductionGraph);
            }
            return { error: `A ${row.asset_type} is not a version that plays; frames are chosen with shot_frame_restore` };
        },
    },

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
                const p = getFilePath(shot.project_id, 'storyboards', frameRow.file_name);
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
                const { resolveFfmpeg, extractFrame } = require('./ffmpeg');
                const bin = resolveFfmpeg();
                if (!bin || !bin.available) {
                    notes.push('a clip exists but no encoder is available to sample frames from it');
                } else {
                    const src = getFilePath(shot.project_id, 'video', clip.file_name);
                    /*
                     * THE DURATION WAS ALWAYS ZERO, SO EVERY SAMPLE WAS FRAME 0.
                     *
                     * This read `(probe(src) || {}).durationSeconds` — but
                     * `probe(bin, args, opts)` takes two arguments and RETURNS A
                     * PROMISE, so the property was undefined, `seconds` fell to
                     * 0, and every `at` computed from it was 0. The tool handed
                     * back five copies of the first frame captioned 0%, 25%,
                     * 50%, 75% and 100% with a timestamp on each — the caption
                     * was the only thing that varied, which is why it read as
                     * working. `measureDurationMs` is the reader that actually
                     * measures a file, and is what the media importer uses.
                     */
                    let seconds = 0;
                    try {
                        seconds = (require('./media-imports').measureDurationMs(src) || 0) / 1000;
                    } catch (_) { seconds = 0; }
                    const n = Math.min(10, Math.max(2, Number(a.samples) || 5));
                    const dir = fsx.mkdtempSync(pathx.join(require('os').tmpdir(), 'fe-frames-'));
                    for (let i = 0; i < n; i++) {
                        const at = seconds ? (seconds * i) / (n - 1 || 1) : 0;
                        const got = extractFrame(src, { atSeconds: at, out: pathx.join(dir, `f${i}.png`),
                            ffmpeg: bin, timeoutMs: 20000 });
                        if (!got.ok) continue;      // one missing sample is not a failed call
                        const uri = asDataUri(got.path, 'image/png');
                        // A frame taken from the start because the seek ran past
                        // the end must not be captioned with the time it asked for.
                        if (uri) images.push({ data_uri: uri,
                            label: got.fellBack
                                ? `clip start (${at.toFixed(1)}s was past the end)`
                                : `clip ${Math.round((i / (n - 1 || 1)) * 100)}% (${got.atSeconds.toFixed(1)}s)` });
                    }
                    try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temp */ }
                    if (images.length <= 1) notes.push('the clip could not be sampled');
                    if (!seconds) notes.push('the clip\'s duration could not be read, so frames were sampled from the start');
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
        description: 'Generate the reference plate for ONE subject. SPENDS CREDITS. Use this rather than plate_generate_all when some subjects already have a plate worth keeping \u2014 a batch run regenerates subjects you were happy with. The plate being replaced is NOT lost — it is archived to versions/ and marked superseded, so it stays on disk and in the ledger but can never be picked up as the reference again. The same protection storyboard frames have, for the same reason: a generation is a coin flip you already paid for. kind is character, location or prop. A location or prop can hold SEVERAL named views \u2014 pass `view` to generate one side without touching the others.',
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
        name: 'plate_consistency',
        description:
            'Whether a character\u2019s turnaround was shot at the SAME settings across its views. Free. '
            + 'Four views that disagree produce a character who changes brightness or colour between the '
            + 'plates, and every frame generated from them inherits that. Exposure is compared as ISO x '
            + 'shutter, so 1/60 at ISO 400 and 1/120 at ISO 800 correctly agree; colour is compared in '
            + 'mired, because 200K apart at tungsten is visible and the same 200K at 8000K is not. A view '
            + 'with no recorded settings is reported as UNCOMPARABLE, never as agreeing \u2014 every plate '
            + 'shot before the camera recorded them carries none. Read this after shooting a turnaround '
            + 'and before generating from it.',
        schema: { character_id: { type: 'string' } },
        required: ['character_id'],
        async run(a) {
            return callRoute('GET', `/film/characters/${a.character_id}/refsheet/consistency`,
                {}, handleCharacters);
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

module.exports = {    listTools, buildTools: listTools, hasTool, callTool, isFailure, presentResult,
    toolNameForNodeType, callRoute,
    NODE_TOOL_PREFIX, ROUTE_TOOLS, PRODUCTION_TOOLS, BATCH_TOOLS, ALL_ROUTE_TOOLS, SSE_EXCEPTION,};
