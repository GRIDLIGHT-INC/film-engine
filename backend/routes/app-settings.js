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
};

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function readSettings() {
    const out = {};
    for (const [key, def] of Object.entries(SETTINGS)) out[key] = def.default;
    try {
        for (const row of db.prepare('SELECT key, value FROM film_app_settings').all()) {
            if (key_known(row.key)) out[row.key] = row.value;
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

    for (const key of Object.keys(SETTINGS)) {
        if (body[key] === undefined) continue;      // merge, so an absent key is "leave it"
        upsert.run(key, String(body[key]));
        changed.push(key);
    }

    /*
     * Turning the local gateway on or off takes effect NOW, not at the next
     * restart. The resolver caches the answer because it is read on every
     * generation, and a switch that needs a restart is one a director flips,
     * watches do nothing, and flips back.
     */
    if (changed.includes('gridlight_enabled')) {
        try {
            const providers = require('../lib/providers');
            providers.refreshLocalGateway();
            // The account default is cached on the generation path for the
            // same reason the gateway switch is; changing it must not need
            // a restart, or the setting appears not to work.
            providers.refreshAccountDefaults();
        } catch (_) { /* not fatal */ }
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
