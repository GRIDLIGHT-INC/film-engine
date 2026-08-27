/**
 * A settings save must not drop the choices it was not asked about.
 *
 * Reported from two real projects. Wingfall held
 * `{"video":"runway","image":"meshy","image_quality":"precision"}` and came
 * back holding only `image_quality`; The Glass Harbour lost both the same way.
 * The tell was that `image_quality` SURVIVED the write that dropped the other
 * two — a partial reconstruction, not a UI-state problem.
 *
 * Two independent causes, and either alone would have been visible:
 *
 * 1. `defaultProviderConfig()` read PREFERRED_WHEN_CONFIGURED assuming every
 *    value was a provider id. When `image` and `video` became ORDERED WALKS —
 *    ["google","meshy","bfl","openai"] — it handed an array to
 *    isProviderConfigured(), which looked it up in the registry, got undefined
 *    and answered false. So every project created after that change was written
 *    with the six string-valued capabilities and no image or video choice.
 *
 * 2. The providers route treated an empty string as "clear this pin", and the
 *    page sends EVERY capability on EVERY save. Any moment a select read blank
 *    — rendered before its options arrived, rendered for another project —
 *    silently deleted a choice.
 *
 * Then a second failure hid the first: with nothing pinned, resolution fell
 * through to the same vendor ranking and picked a company the account had never
 * named, and the error read `google: API_KEY_INVALID` — which blames a
 * credential.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// An isolated database. tests/test-isolation.test.js exists because a test
// that opens the real one edits the user's own films.
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-pcfg-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const providers = require('../lib/providers');
const { handleProviders } = require('../routes/providers');

/** Call the real route and hand back what it wrote. */
function putProviders(projectId, body) {
    return new Promise(resolve => {
        const res = { writeHead() {}, end(payload) { resolve(JSON.parse(payload)); } };
        handleProviders({ method: 'PUT', body }, res, ['film', 'projects', projectId, 'providers'], {});
    });
}

function seedProject(id, config) {
    db.prepare(`INSERT INTO film_projects (id, title, provider_config, created_at, updated_at)
                VALUES (?, 'probe', ?, datetime('now'), datetime('now'))`)
        .run(id, JSON.stringify(config));
}

function storedConfig(id) {
    return JSON.parse(db.prepare('SELECT provider_config FROM film_projects WHERE id = ?')
        .get(id).provider_config);
}

test('a preference may be an ordered walk, and the default config reads it', () => {
    /*
     * DERIVED from the table itself, so a capability converted to a walk later
     * is covered without anyone remembering. A hand-written list of "the two
     * that are arrays" is exactly what let this ship.
     */
    const walks = Object.entries(providers.PREFERRED_WHEN_CONFIGURED)
        .filter(([, v]) => Array.isArray(v));
    assert.ok(walks.length >= 2, 'expected image and video to be ordered walks');

    const config = providers.defaultProviderConfig();
    for (const [capability, order] of walks) {
        // Only assert where something in the walk is actually credentialed:
        // an install with no key for any of them correctly gets no default.
        const anyConfigured = order.some(id => providers.isProviderConfigured(id));
        if (!anyConfigured) continue;
        assert.ok(config[capability],
            `${capability} is an ordered walk and a new project would be created with no `
            + 'choice for it — so it falls through to a vendor ranking it never saw');
        assert.ok(order.includes(config[capability]),
            `${capability} defaulted to ${config[capability]}, which is not in its own preference order`);
    }
});

test('firstConfigured accepts both shapes', () => {
    // One reading of the preference table, shared with resolveId. Two readings
    // is how the two came to disagree in the first place.
    assert.strictEqual(providers.firstConfigured([]), null);
    assert.strictEqual(providers.firstConfigured('nosuchprovider'), null);
    assert.strictEqual(providers.firstConfigured(['nosuchprovider']), null);
});

test('an empty string is "no opinion", not "delete this"', async () => {
    /*
     * Exercised through the real route against a real database, because the
     * bug was in what the route DID with the payload, not in any pure function.
     */
    const id = 'a1111111-1111-4111-8111-111111111111';
    seedProject(id, { image: 'meshy', video: 'runway', image_quality: 'precision' });

    await putProviders(id, { config: { image: '', video: '', image_quality: 'draft' } });

    const after = storedConfig(id);
    assert.strictEqual(after.image, 'meshy', 'a blank select cleared a pin the director chose');
    assert.strictEqual(after.video, 'runway', 'a blank select cleared a pin the director chose');
    assert.strictEqual(after.image_quality, 'draft', 'the field actually being changed did not change');
});

test('every pre-existing key survives a save that touches only one', async () => {
    // The regression the report asked for, stated as the whole object.
    const id = 'a3333333-3333-4333-8333-333333333333';
    const original = {
        llm: 'anthropic', image: 'meshy', video: 'runway', music: 'elevenlabs',
        voice: 'elevenlabs', sfx: 'elevenlabs', ambient: 'elevenlabs',
        model3d: 'meshy', image_quality: 'precision',
    };
    seedProject(id, original);

    await putProviders(id, { config: { image_quality: 'draft' } });

    const after = storedConfig(id);
    for (const [key, value] of Object.entries(original)) {
        if (key === 'image_quality') continue;
        assert.strictEqual(after[key], value, `${key} was dropped by a write that never mentioned it`);
    }
    assert.strictEqual(after.image_quality, 'draft');
});

test('null clears a pin, deliberately', async () => {
    // Clearing must stay possible, or "let the quality tier decide" is
    // unsayable and the tier picker's own advice points at a dead end.
    const id = 'a2222222-2222-4222-8222-222222222222';
    seedProject(id, { image: 'meshy', video: 'runway' });

    await putProviders(id, { config: { image: null } });

    const after = storedConfig(id);
    assert.strictEqual(after.image, undefined, 'null must clear the pin');
    assert.strictEqual(after.video, 'runway', 'clearing one must not touch another');
});

test('a resolution says where it came from, and whether anyone chose it', () => {
    /*
     * The second half of the compound failure. A provider id alone cannot tell
     * "this project chose Runway" from "nothing was set, so a list in this
     * repository picked one" — and those produce identical, confident errors.
     */
    const explicit = providers.resolveIdWithReason('image', { image: 'meshy' });
    assert.strictEqual(explicit.id, 'meshy');
    assert.strictEqual(explicit.source, 'project');
    assert.strictEqual(explicit.explicit, true);

    /*
     * With no account default set, a project that pinned nothing must report
     * its provider as a GUESS. The account default is read from app settings,
     * so the temp database — which has none — is what makes this meaningful;
     * asserting it against a real install would pass or fail depending on
     * whether the person happened to have set one.
     */
    providers.refreshAccountDefaults();
    const guessed = providers.resolveIdWithReason('image', {});
    assert.strictEqual(guessed.explicit, false,
        'a project that pinned nothing must report its provider as a guess, not a choice');

    /*
     * Stated as a PROPERTY rather than an example, because the answer depends
     * on the install: a machine with credentials resolves through a preference
     * walk, and one without resolves to nothing at all. Both are correct, and
     * an example assertion would pass on whichever machine it was written on.
     */
    for (const cfg of [{}, { image_quality: 'precision' }, { image: 'meshy' }]) {
        const r = providers.resolveIdWithReason('image', cfg);
        const sentence = providers.describeResolution('image', cfg);
        if (!r.id) {
            assert.match(sentence, /no image provider is available/,
                'a capability nothing serves must say so, not name a provider');
        } else if (!r.explicit) {
            assert.match(sentence, /FALLBACK/,
                `resolved ${r.id} that nobody chose, and the sentence does not say it was a fallback`);
        } else {
            assert.doesNotMatch(sentence, /FALLBACK/,
                `${r.id} was chosen deliberately and is being reported as a fallback`);
        }
    }
    assert.match(providers.describeResolution('image', { image: 'meshy' }), /pinned by this project/);
});

test('resolveId still answers exactly what the reasoned form answers', () => {
    // The wrapper must not drift from the function it wraps.
    for (const cfg of [{}, { image: 'meshy' }, { image_quality: 'precision' }, { video: 'runway' }]) {
        for (const cap of ['image', 'video']) {
            assert.strictEqual(providers.resolveId(cap, cfg),
                providers.resolveIdWithReason(cap, cfg).id, `disagreement for ${cap} ${JSON.stringify(cfg)}`);
        }
    }
});

test('provider_config is writable over MCP, with the same merge semantics', async () => {
    /*
     * Provider selection is per project, and PUT /projects refused the field
     * outright with "No valid fields to update" — so an agent could create a
     * project and then could neither configure it nor repair one whose config
     * had been damaged. The only way in was the page, which is the wrong
     * constraint for a pipeline whose reasoning happens in an agent host.
     */
    const { handleProjects } = require('../routes/projects');
    const id = 'a4444444-4444-4444-8444-444444444444';
    seedProject(id, { image: 'meshy', video: 'runway', llm: 'anthropic' });

    const call = body => new Promise(resolve => {
        const res = {
            writeHead(status) { this._status = status; },
            end(payload) { resolve({ status: this._status, body: JSON.parse(payload) }); },
        };
        handleProjects({ method: 'PUT', body }, res, ['film', 'projects', id], {});
    });

    // Merges: naming one capability must not drop the others.
    await call({ provider_config: { video: 'seedance' } });
    let after = storedConfig(id);
    assert.strictEqual(after.video, 'seedance');
    assert.strictEqual(after.image, 'meshy', 'writing video dropped image');
    assert.strictEqual(after.llm, 'anthropic', 'writing video dropped llm');

    // null clears, matching the providers route — one payload, one meaning.
    await call({ provider_config: { image: null } });
    assert.strictEqual(storedConfig(id).image, undefined);

    // A provider that does not exist is refused rather than stored: a pin
    // nothing can resolve is sent and silently ignored at generation time.
    const bad = await call({ provider_config: { image: 'nosuchvendor' } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /Unknown provider/);
    assert.ok(Array.isArray(bad.body.providers), 'the refusal must say what IS valid');
});

test('the MCP tool advertises provider_config and its merge semantics', () => {
    const { listTools } = require('../lib/mcp-tools');
    const tool = listTools().find(t => t.name === 'project_update');
    const prop = tool.inputSchema.properties.provider_config;
    assert.ok(prop, 'project_update cannot set provider_config, so an agent cannot configure a project');
    assert.match(prop.description, /MERGED/,
        'the description must say keys you omit are kept — otherwise a caller sends a full object and drops the rest');
});
