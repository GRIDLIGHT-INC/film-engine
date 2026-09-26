/**
 * Settings that belong to the person, not the project.
 *
 * GET /film/settings          — read them all
 * PUT /film/settings          — merge; send only what changes
 *
 * `author` is the first and, today, the only one. It was a free-text field on
 * every screenplay's title page — retyped per project, per draft, and blank
 * whenever anyone forgot, which on a title page is exactly the field a reader
 * looks at first. It is not a fact about a screenplay. It is a fact about
 * whoever is writing them here, and it is the same answer every time.
 */

const { db } = require('../db/database');

/**
 * The settings this app understands, with what each is for.
 *
 * An allow-list rather than an open store: a PUT that accepts any key at all
 * turns a settings endpoint into a place where typos are persisted forever and
 * nothing ever reads them.
 */
const SETTINGS = {
    author: {
        description: 'Written-by credit on every screenplay title page and every FDX export.',
        default: '',
    },
    // The subscription is the person's, not the project's — one pool shared
    // across every film they work on. Stored here for the same reason `author`
    // is: it is the same answer every time and belongs to whoever is sitting
    // at the machine.
    /*
     * The local Gridlight gateway, OFF until switched on.
     *
     * It declares `requiresKey: false`, so every readiness check has answered
     * "configured" for it whether or not anything is listening on the port —
     * and it is the fallback every capability drops to. A capability with no
     * hosted adapter therefore resolved to a service that may not be running,
     * and the only symptom was a connection refused at generation time, per
     * capability, after the work had been committed to.
     *
     * Default is OFF rather than on. A feature that is enabled until you find
     * the setting is one every existing project is already using without having
     * chosen to, and here "using" means pointing paid generation at a closed
     * port.
     */
    /*
     * THE MUSIC RIGHTS POLICY (MUS-022): what each rights status does at
     * approval and at final export — allow, warn or block. Blank is the stated
     * default in lib/music-rights.js; a value replaces only the parts it names.
     */
    /*
     * WHERE NEW PROJECTS GO. The folder a new project's own folder is made
     * inside, offered as the default when a project is started and changeable
     * there. Blank is `~/Film Engine` (lib/project-folders.js).
     */
    projects_root: {
        description: 'The folder new projects are saved in: each project gets its own folder inside it, e.g. "~/Film Engine". Blank uses ~/Film Engine.',
        default: '',
        validate: v => {
            if (v === '' || v === null || v === undefined) return [];
            const expanded = require('../lib/project-folders').expandHome(String(v));
            return require('path').isAbsolute(expanded) ? [] : ['projects_root must be a full path (start it with / or ~/)'];
        },
        example: '~/Film Engine',
    },
    music_rights_policy: {
        description: 'JSON: what each music rights status does at each gate, e.g. {"approval":{"unknown":"warn"},"final_export":{"restricted":"block"}}. Statuses: cleared, unknown, restricted, expired, blocked; actions: allow, warn, block. Blank keeps the stated default (unknown and restricted warn; expired blocks final export; blocked blocks both).',
        default: '',
        validate: v => require('../lib/music-rights').validatePolicy(v),
        // A value the validator accepts, so anything probing every setting can write a real one.
        example: '{"approval":{"unknown":"warn"}}',
    },
    gridlight_enabled: {
        description: 'Turn on the local Gridlight endpoints. Off by default: until it is enabled, '
            + 'nothing resolves to it, and a capability it is the only provider for reports that '
            + 'nothing serves it rather than failing at generation time. Set GRIDLIGHT_URL if the '
            + 'service is not on localhost:8080.',
        default: '',
    },
    subscription_plan: {
        description: 'Which Claude/ChatGPT plan drives the MCP host: free, pro, max_5x, max_20x. Used only to scale a calibrated baseline across plans — no ceiling is assumed from the name alone.',
        default: '',
    },
    subscription_session_tokens: {
        description: 'Your own measurement of how many tokens fit in one rolling 5-hour window. Anthropic publishes no such number, so the spend gauge shows no percentage until you set this. Leave blank to see raw consumption without a bar.',
        default: '',
    },
    /*
     * WHICH GENERATOR A PROJECT THAT NAMED NONE SHOULD USE.
     *
     * Before this, an unpinned capability fell through to
     * PREFERRED_WHEN_CONFIGURED — an ordered list of vendors written in this
     * repository. So a project that named nothing generated on whichever
     * company happened to be first in a walk it had never seen, and the only
     * symptom was an authentication error naming a vendor the director never
     * chose. That is a defensible default for a shipped product and a bad one
     * for a person's own account, which has an obvious right answer: whoever
     * they actually use.
     *
     * Per person rather than per project, like `author`: it is the same answer
     * every time. Blank keeps the built-in walk, so nothing changes for anyone
     * who does not set it.
     */
    llm_subscription_plan: {
        description: 'Which Claude subscription this install runs on: none (API pay-as-you-go), '
            + 'pro ($20), max_5x ($100), max_20x ($200) or team ($30/seat). The LLM is billed to '
            + 'the subscription rather than per call, so spend_report charges the project NOTHING '
            + 'for it \u2014 setting this adds a separate ATTRIBUTION line: this project\u2019s share of '
            + 'the monthly fee, by the tokens it actually used against every project this month. '
            + 'Anthropic publishes plan prices but no token allowance, so the share is measured, '
            + 'never divided out of an invented quota.',
        default: 'none',
    },
    default_image_provider: {
        description: 'Which image generator a project that pins none should use. Blank falls back to '
            + 'the built-in preference order, which is a list of vendors chosen here rather than by you.',
        default: '',
    },
    default_video_provider: {
        description: 'Which video generator a project that pins none should use. Blank falls back to '
            + 'the built-in preference order.',
        default: '',
    },
    subscription_pro_baseline_tokens: {
        description: 'A Pro-plan 5-hour baseline. Set this instead of the above and the published plan multipliers (Max 5x, Max 20x) scale it for you, so one measurement calibrates every plan.',
        default: '',
    },

    /*
     * WORLD ENGINE — six flags, every one OFF.
     *
     * They belong to the machine rather than to a project because they gate
     * whether the feature EXISTS, not how a film is made — the same reasoning
     * that put `author` and the subscription baseline here. Defaulting off is
     * what makes the feature shippable in phases against a live install: with
     * all six clear, the app is byte-identical to the one running today.
     */
    world_engine: {
        description: 'Show the World Engine console on the Previs page. Off leaves the existing previs screen exactly as it is.',
        default: false,
    },
    marble_generation: {
        description: 'Allow generating spatial worlds through World Labs Marble. This is the only World Engine flag that unlocks spending.',
        default: false,
    },
    cinematography_ai: {
        description: 'Offer Direct the Shot. The proposal is written by the connected model over MCP; the engine only computes the facts and validates the result.',
        default: false,
    },
    reference_match: {
        description: 'Offer Match Reference Composition — a manual-assist solve from a marked horizon and subject box, not automatic detection.',
        default: false,
    },
    camera_explore: {
        description: 'Offer Explore Shot: six alternative cameras in one world, each validated against the geometry before it is shown.',
        default: false,
    },
    /*
     * THE PRODUCTION GRAPH. One page replaces the eight production pages; off,
     * the phase is exactly as it was. The eight stay reachable by URL either
     * way until the graph has proved parity, so turning it on removes nothing.
     */
    production_graph: {
        description: 'Show Production as one node graph (shots, sequences, sound and versions) instead of its eight separate pages.',
        default: false,
    },
    world_splats: {
        description: 'Download and render Gaussian splats. Off records the splat URLs and fetches nothing — full_res is 25 MB per world.',
        default: false,
    },
};

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/*
 * A SETTING MUST COME BACK THE TYPE IT WENT IN AS.
 *
 * film_app_settings stores TEXT, and every value went through String(). A
 * boolean written as `false` therefore came back as the STRING "false" — which
 * is truthy, so a flag switched OFF read as ON everywhere. Measured: with
 * world_engine set to false the console still rendered, because `!!'false'` is
 * true. A switch a director flips and watches do nothing is the failure this
 * file already records for the gateway; this is the same one, in the store.
 *
 * The default declares the type, so nothing has to be listed twice.
 */
function serialiseLike(def, value) {
    if (typeof def === 'boolean') {
        const s = String(value).trim().toLowerCase();
        return (value === true || s === 'true' || s === '1' || s === 'on') ? '1' : '';
    }
    return String(value);
}

function castLike(def, stored) {
    if (typeof def === 'boolean') {
        const s = String(stored == null ? '' : stored).trim().toLowerCase();
        return !(s === '' || s === '0' || s === 'false' || s === 'off');
    }
    return stored;
}

function readSettings() {
    const out = {};
    for (const [key, def] of Object.entries(SETTINGS)) out[key] = def.default;
    try {
        for (const row of db.prepare('SELECT key, value FROM film_app_settings').all()) {
            if (key_known(row.key)) out[row.key] = castLike(SETTINGS[row.key].default, row.value);
        }
    } catch (_) { /* table not migrated yet; the defaults are the honest answer */ }
    return out;
}

function key_known(key) {
    return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

function getSettings(req, res) {
    return json(res, 200, {
        settings: readSettings(),
        known: Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.description])),
    });
}

function putSettings(req, res) {
    const body = req.body || {};
    const changed = [];
    const unknown = Object.keys(body).filter(k => !key_known(k));

    const upsert = db.prepare(
        `INSERT INTO film_app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);

    // A setting that declares a validator is checked before anything is written, so a bad value never half-lands.
    for (const key of Object.keys(SETTINGS)) {
        if (body[key] === undefined || typeof SETTINGS[key].validate !== 'function') continue;
        const errors = SETTINGS[key].validate(body[key]);
        if (errors && errors.length) return json(res, 400, { error: errors.join('; '), key });
    }

    for (const key of Object.keys(SETTINGS)) {
        if (body[key] === undefined) continue;      // merge, so an absent key is "leave it"
        upsert.run(key, serialiseLike(SETTINGS[key].default, body[key]));
        changed.push(key);
    }

    /*
     * Turning the local gateway on or off takes effect NOW, not at the next
     * restart. The resolver caches the answer because it is read on every
     * generation, and a switch that needs a restart is one a director flips,
     * watches do nothing, and flips back.
     */
    /*
     * A CACHED SETTING MUST BE CLEARED BY ITS OWN KEY.
     *
     * This whole block was gated on `gridlight_enabled`, and the comment inside
     * it correctly explained why the account default must not need a restart —
     * while sitting behind a condition that could only be true when a DIFFERENT
     * setting changed. So changing `default_image_provider` cached the old
     * answer until the process was restarted: the setting appeared not to work,
     * which is precisely the failure the comment describes.
     *
     * Each cache is now cleared by the key that invalidates it.
     */
    if (changed.includes('gridlight_enabled')) {
        try { require('../lib/providers').refreshLocalGateway(); } catch (_) { /* not fatal */ }
    }
    if (changed.includes('default_image_provider') || changed.includes('default_video_provider')
        || changed.includes('gridlight_enabled')) {
        // The account default is read on every generation and cached; a switch
        // that needs a restart is one a director flips, watches do nothing, and
        // flips back.
        try { require('../lib/providers').refreshAccountDefaults(); } catch (_) { /* not fatal */ }
    }

    if (!changed.length) {
        return json(res, 400, {
            error: `Nothing to change. Known settings: ${Object.keys(SETTINGS).join(', ')}`,
            unknown,
        });
    }
    // Unknown keys are reported rather than ignored: a caller that misspelled
    // one otherwise gets a 200 and believes it was saved.
    return json(res, 200, { settings: readSettings(), changed, unknown });
}

function handleAppSettings(req, res) {
    if (req.method === 'GET') return getSettings(req, res);
    if (req.method === 'PUT') return putSettings(req, res);
    return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { handleAppSettings, readSettings, SETTINGS };
