/**
 * When spend goes somewhere the project did not choose, something says so
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "`film_projects.provider_config` lost its `image` key mid-session. Nothing
 *  failed and nothing was reported. Image generation fell through the
 *  resolution order onto Google, billed against a personal Gemini key rather
 *  than the Meshy account the project was configured for — discovered only when
 *  Google's billing rejected it."
 *
 * The reason was already computed. `resolveIdWithReason` returns a `source`
 * (`project` / `env` / `quality_tier` / `account_default` / the preference
 * walk) and an `explicit` flag, and `describeResolution` turns it into the
 * exact sentence needed:
 *
 *     resolved provider: google (FALLBACK — this project pins no provider,
 *     so a built-in preference order picked one)
 *
 * `describeResolution` had **zero consumers**. Declared, exported, and wired to
 * nothing — the same shape as `NEVER_WRITES`, `scope` on PIPELINE_STEPS and
 * `voice_id` on a character. Every generation called `resolveId`, which throws
 * the reason away on its only line.
 *
 * The engine's own comment predicted this and it happened anyway:
 *
 *     the picker said every tier used Meshy while the project resolved to
 *     OpenAI, and both were telling the truth about different code.
 *
 * SET-BASED OVER (capability x surface), because the failure is partial by
 * nature: a note on the image path and silence on video is how a director
 * learns to trust the note and then gets billed for footage by a vendor they
 * never chose. The capability list is `providers.CAPABILITIES`, so one added
 * later is covered with nothing to remember.
 *
 * The distinction that matters is EXPLICIT vs INFERRED, not which provider won.
 * A project pinned to Google is not a problem; a project that pins nothing and
 * silently lands on Google is.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-prv-' + crypto.randomUUID().slice(0, 8));

const providers = require('../lib/providers');
const CAPS = providers.CAPABILITIES;
/*
 * Images are the one capability that CANNOT fall through: the house standard
 * (lib/image-standard.js) decides them, and a rule the director stated is
 * reported as explicit. The fallback checks below run over everything else;
 * images are held to reporting the standard instead.
 */
const FALLBACK_CAPS = CAPS.filter(c => c !== 'image');

/*
 * A CREDENTIAL HAS TO EXIST FOR ANYTHING TO FALL THROUGH TO.
 *
 * The resolution order only ever offers a provider that holds a key, so an
 * isolated database resolves every capability to null -- and every assertion
 * below then skips, passes, and proves nothing. Found by mutation: making the
 * dry run claim every provider was explicitly chosen survived until this
 * existed.
 */
const { db } = require('../db/database');
require('../db/schema').ensureSchema();
db.prepare(`INSERT OR REPLACE INTO film_provider_credentials (provider, api_key, meta, updated_at)
    VALUES ('meshy', 'test-key-not-a-real-one', '{}', datetime('now'))`).run();
try { providers.refreshAccountDefaults(); } catch (_) {}

test('the capability list is the real one and is not empty', () => {
    assert.ok(Array.isArray(CAPS) && CAPS.length >= 8,
        `expected the real capability list, saw ${JSON.stringify(CAPS)}`);
});

// ---------------------------------------------------------------------------
// 1. The registry answers the question at all, for every capability
// ---------------------------------------------------------------------------

test('every capability can say WHERE its provider choice came from', () => {
    const silent = [];
    for (const cap of CAPS) {
        const r = providers.resolveIdWithReason(cap, {});
        if (!r || typeof r.source !== 'string' || !r.source) silent.push(`${cap}: no source reported`);
        if (r && r.id && typeof r.explicit !== 'boolean') silent.push(`${cap}: does not say whether the choice was explicit`);
    }
    assert.deepStrictEqual(silent, [], silent.join('\n  '));
});

test('an unpinned capability is reported as a fallback, a pinned one is not', () => {
    const wrong = [];
    const img = providers.resolveIdWithReason('image', {});
    if (img.id && (img.source !== 'house_standard' || !img.explicit)) {
        wrong.push(`image: resolved "${img.id}" from ${img.source}, not from the house standard`);
    }
    for (const cap of FALLBACK_CAPS) {
        const loose = providers.resolveIdWithReason(cap, {});
        if (loose.id && loose.explicit) {
            wrong.push(`${cap}: an empty config resolved "${loose.id}" and called it explicit`);
        }
        // Pin it to whatever it would have picked anyway: the ID is unchanged,
        // so only the SOURCE can distinguish the two, which is the whole point.
        if (loose.id) {
            const pinned = providers.resolveIdWithReason(cap, { [cap]: loose.id });
            if (!pinned.explicit) wrong.push(`${cap}: pinned to "${loose.id}" and still not reported as explicit`);
            if (pinned.id !== loose.id) wrong.push(`${cap}: pinning to its own answer changed it to "${pinned.id}"`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

// ---------------------------------------------------------------------------
// 2. Every surface that NAMES a provider also says where it came from
// ---------------------------------------------------------------------------

test('describeResolution names a fallback as a fallback, in words', () => {
    for (const cap of CAPS) {
        const r = providers.resolveIdWithReason(cap, {});
        if (!r.id) continue;
        const said = providers.describeResolution(cap, {});
        assert.match(said, new RegExp(r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
            `${cap}: the sentence does not name the provider it resolved`);
        if (!r.explicit) {
            assert.match(said, /FALLBACK|default|preference|gateway/i,
                `${cap}: resolved "${r.id}" with nobody having chosen it, and the sentence does not say so: ${said}`);
        }
    }
});

test('the adapter a generation is about to use carries its own provenance', () => {
    /*
     * `resolve()` is the ONE funnel every generation goes through -- the
     * per-domain routes, the orchestrator and the flow canvas all obtain their
     * adapter here. Attaching the provenance at that single point is what makes
     * it impossible for one path to report it and another to stay silent.
     */
    const missing = [];
    for (const cap of CAPS) {
        const adapter = providers.resolve(cap, {});
        if (!adapter) { missing.push(`${cap}: resolve() returned nothing`); continue; }
        const res = adapter.__resolution;
        if (!res) { missing.push(`${cap}: the resolved adapter carries no __resolution`); continue; }
        if (typeof res.explicit !== 'boolean') missing.push(`${cap}: __resolution does not say whether it was explicit`);
        if (!res.note) missing.push(`${cap}: __resolution carries no readable note`);
        if (res.capability !== cap) missing.push(`${cap}: __resolution says it is for "${res.capability}"`);
    }
    assert.deepStrictEqual(missing, [], missing.join('\n  '));
});

test('provenance never leaks into a stored provider_config', () => {
    /*
     * Non-enumerable on purpose, exactly as `__project_id` is. A project's
     * provider_config is round-tripped through the settings panel, and a
     * diagnostic field that rode along would be written back into the column on
     * the next save -- which is how `provider_config` acquires keys nobody set.
     */
    const adapter = providers.resolve('image', {});
    assert.ok(adapter.__resolution, 'nothing to check');
    assert.ok(!Object.keys(adapter).includes('__resolution'),
        '__resolution is enumerable and would be serialised into stored config');
    assert.strictEqual(JSON.parse(JSON.stringify({ ...adapter })).__resolution, undefined,
        '__resolution survives a JSON round trip of the adapter');
});

// ---------------------------------------------------------------------------
// 3. The reports a person actually reads
// ---------------------------------------------------------------------------

test('the settings payload says, per capability, whether anyone chose it', async () => {
    /*
     * Driven through the ROUTE, not the library function. Asserting on
     * `resolutionReport` directly proves the helper works and says nothing
     * about whether the payload a page receives carries it -- proven by
     * mutation: deleting the field from the response survived until this went
     * through handleProviders.
     */
    const { handleProviders } = require('../routes/providers');
    const { generateId } = require('../db/database');
    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, provider_config, created_at, updated_at)
        VALUES (?, ?, '{}', datetime('now'), datetime('now'))`).run(pid, 'settings probe');

    const served = await new Promise(resolve => {
        const chunks = [];
        const res = {
            writeHead(code) { this.statusCode = code; return this; },
            end(payload) { chunks.push(payload || ''); resolve(JSON.parse(chunks.join('') || '{}')); },
        };
        const url = `/film/projects/${pid}/providers`;
        handleProviders({ method: 'GET', url, body: {} }, res, url.split('/').filter(Boolean));
    });

    const rep = served.resolution || {};
    assert.ok(Object.keys(rep).length >= 1,
        'the providers payload carries no resolution at all — the page cannot show who chose a vendor');
    const gaps = [];
    for (const cap of CAPS) {
        const row = rep[cap];
        if (!row) { gaps.push(`${cap}: absent from the resolution report`); continue; }
        if (typeof row.explicit !== 'boolean') gaps.push(`${cap}: no explicit flag`);
        if (!row.note) gaps.push(`${cap}: no note`);
    }
    assert.deepStrictEqual(gaps, [], gaps.join('\n  '));

    // And a pin must flip it, or the flag is decoration: the provider NAME is
    // identical either way, which is exactly why this was invisible.
    // model3d rather than image: images follow the house standard and are
    // explicit whether or not the project pins them.
    const img = rep.model3d;
    if (img && img.provider) {
        assert.strictEqual(img.explicit, false,
            'this project pins nothing and its model3d provider was reported as explicitly chosen');
        const pinned = providers.resolutionReport({ model3d: img.provider }).model3d;
        assert.strictEqual(pinned.explicit, true,
            'pinning the model3d provider did not change the report');
        assert.strictEqual(pinned.provider, img.provider,
            'pinning changed which provider resolved — the two cases are no longer comparable');
    }
});

test('the dry run reports where each capability was routed and why', () => {
    const { describeCapability } = require('../lib/dry-run');
    const silent = [];
    let checked = 0;
    for (const cap of FALLBACK_CAPS) {
        const loose = describeCapability(cap, {}, {});
        if (!loose.provider) continue;                    // nothing serves it
        /*
         * Only a REGISTERED adapter is an account that can be billed. With no
         * credentials present, `llm` reports "the MCP host" -- which names no
         * adapter, spends nothing, and is the architecture rather than a silent
         * reroute. Derived from the registry rather than exempting `llm` by
         * name, so a second capability that answers this way is covered too.
         */
        if (!providers.get(loose.provider)) continue;
        checked++;
        if (typeof loose.provider_explicit !== 'boolean') {
            silent.push(`${cap}: dry run names "${loose.provider}" and does not say who chose it`);
            continue;
        }
        /*
         * Asserted POSITIVELY. Checking only "if it says fallback, it warns"
         * passes against a report that claims every capability was explicitly
         * chosen -- which is the comfortable lie, and the one this exists to
         * catch. Nothing is pinned here, so nothing may be reported as pinned.
         */
        if (loose.provider_explicit !== false) {
            silent.push(`${cap}: nothing is pinned and the dry run reports "${loose.provider}" as explicitly chosen`);
        }
        const warned = (loose.notes || []).some(n => /pins no/.test(n));
        if (!warned) silent.push(`${cap}: fell through to "${loose.provider}" with no note saying so`);
        // Pinning to the same answer must flip the flag and drop the warning,
        // or the flag is decoration: the provider string is identical either way.
        const pinned = describeCapability(cap, {}, { [cap]: loose.provider });
        if (pinned.provider === loose.provider && !pinned.provider_explicit) {
            silent.push(`${cap}: pinned to "${loose.provider}" and still reported as a fallback`);
        }
    }
    assert.ok(checked >= 1,
        'no capability resolved to a registered provider — the dry-run check ran against nothing');
    assert.deepStrictEqual(silent, [], silent.join('\n  '));
});

test('the run plan names the vendor each strip would spend at', () => {
    /*
     * Behavioural, against a real project with real work: a source check passes
     * against a plan that computes `routing` and returns an empty array, which
     * is what a project with no strips legitimately produces.
     */
    const { generateId } = require('../db/database');
    const { buildRunPlan } = require('../lib/run-plan');

    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, provider_config, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))`)
        .run(pid, 'routing probe', JSON.stringify({ image: 'meshy' }));
    const sid = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location, created_at)
        VALUES (?, ?, 1, 'A ROOM', datetime('now'))`).run(sid, pid);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml)
        VALUES (?, ?, '1A', ?)`)
        .run(generateId(), sid, JSON.stringify({ shot_code: '1A', description: 'a room' }));

    const plan = buildRunPlan(pid, {});
    assert.ok(Array.isArray(plan.routing), 'the run plan reports no routing at all');
    assert.ok(plan.routing.length >= 1,
        `the plan has ${(plan.strips || []).length} strips and named no vendor for any of them`);

    for (const r of plan.routing) {
        assert.ok(typeof r.explicit === 'boolean', `${r.capability}: routing row has no explicit flag`);
        assert.ok(r.note, `${r.capability}: routing row has no readable note`);
    }

    const img = plan.routing.find(r => r.capability === 'image');
    assert.ok(img, 'the plan named no vendor for the image strip');
    assert.strictEqual(img.explicit, true,
        'the project pins image to meshy and the plan did not report that as explicit');

    /*
     * A SECOND PROJECT THAT PINS NOTHING.
     *
     * The one above pins image, and in an isolated test environment the other
     * capabilities hold no credential and resolve to null -- so it has no
     * unpinned row at all, and every assertion about the warning passes
     * vacuously. Proven by mutation: dropping the capability prefix from the
     * warning survived until this project existed.
     */
    /*
     * A credential has to exist for anything to fall through TO. The resolution
     * order only offers a provider that holds a key, so an isolated database
     * resolves every capability to null and the fallback case cannot occur at
     * all -- which is itself a way for this test to pass while proving nothing.
     */
    const loose = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, provider_config, created_at, updated_at)
        VALUES (?, ?, '{}', datetime('now'), datetime('now'))`).run(loose, 'unpinned probe');
    const lsid = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location, created_at)
        VALUES (?, ?, 1, 'A ROOM', datetime('now'))`).run(lsid, loose);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml)
        VALUES (?, ?, '1A', ?)`)
        .run(generateId(), lsid, JSON.stringify({ shot_code: '1A', description: 'a room' }));

    // Images never fall through (the house standard decides them), so video
    // needs a key of its own for the plan to have an unpinned row at all.
    db.prepare(`INSERT OR REPLACE INTO film_provider_credentials (provider, api_key, meta, updated_at)
        VALUES ('seedance', 'test-key-not-a-real-one', '{}', datetime('now'))`).run();
    const plan2 = buildRunPlan(loose, {});
    const fellThrough = plan2.routing.filter(r => r.provider && !r.explicit);
    assert.ok(fellThrough.length >= 1,
        'a project pinning nothing produced no fallback rows — the probe cannot test the warning');

    for (const r of fellThrough) {
        assert.ok((plan2.unpinned_providers || []).some(n => n.startsWith(`${r.capability}:`)),
            `${r.capability} fell through to "${r.provider}" and is not named, with its capability, `
            + `in unpinned_providers (${JSON.stringify(plan2.unpinned_providers)})`);
    }
});
