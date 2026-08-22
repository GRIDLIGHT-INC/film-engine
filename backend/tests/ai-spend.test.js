/**
 * AI spend: every provider call is metered, priced and attributed.
 *
 * The budget area was built for a live-action production — catering, grip,
 * SAG day rates, shooting days. None of that is what this pipeline spends.
 * What it spends is tokens, credits, characters and seconds of generated
 * media, and NOTHING recorded any of it: `film_cost_entries` had exactly one
 * writer, a manual POST that a human had to fill in by hand. So a project
 * could generate forty images and report a spend of zero.
 *
 * This suite is SET-BASED over the provider registry rather than written
 * against one provider, because the failure is per-pair and partial: a rate
 * book covering Anthropic and Runway while leaving Meshy unpriced reports a
 * plausible number that is wrong by exactly the images, which is the single
 * biggest line on a storyboard-heavy project. An example test passes in that
 * state.
 *
 * The set is derived from `providers.list()` — the same registry generation
 * resolves through — never from a list typed here, or the next adapter added
 * arrives unpriced and silently free.
 */

process.env.FILM_DATA_DIR = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'film-spend-test-')
);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../db/schema').ensureSchema();

const providers = require('../lib/providers');
const pricing = require('../lib/provider-pricing');
const meter = require('../lib/usage-meter');
const { CAPABILITIES } = require('../lib/providers/base');

/** Every (provider, capability) pair generation can actually resolve to. */
function pairs() {
    const out = [];
    for (const adapter of providers.list()) {
        for (const capability of adapter.capabilities || []) {
            out.push({ provider: adapter.id, capability, adapter });
        }
    }
    return out;
}

test('the registry is non-empty and covers every capability (guard)', () => {
    const all = pairs();
    assert.ok(all.length >= 20, `only ${all.length} provider/capability pairs — the scans below would be near-vacuous`);
    const served = new Set(all.map(p => p.capability));
    for (const capability of CAPABILITIES) {
        if (capability === 'stock') continue;   // no source adapter ships today
        assert.ok(served.has(capability), `no provider serves '${capability}'`);
    }
});

// ── 1. Every pair is priced ────────────────────────────────────────────────

test('every provider/capability pair has a published rate', () => {
    const missing = [];
    for (const { provider, capability } of pairs()) {
        const rate = pricing.rateFor(provider, capability);
        if (!rate) { missing.push(`${provider}:${capability}`); continue; }
        assert.ok(pricing.BILLING_UNITS.includes(rate.unit),
            `${provider}:${capability} bills in '${rate.unit}', which is not a known billing unit`);
        assert.ok(Number.isFinite(rate.usd_per_unit) && rate.usd_per_unit >= 0,
            `${provider}:${capability} has no usable usd_per_unit`);
    }
    assert.deepStrictEqual(missing, [], `unpriced pairs generate for free in the report: ${missing.join(', ')}`);
});

test('every rate cites where its number came from', () => {
    // A rate with no source cannot be re-checked when a provider changes its
    // pricing, and an un-recheckable number decays into a confident lie.
    for (const { provider, capability } of pairs()) {
        const rate = pricing.rateFor(provider, capability);
        assert.ok(rate.source && /^https?:\/\//.test(rate.source),
            `${provider}:${capability} has no source URL`);
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(rate.checked || ''),
            `${provider}:${capability} does not say when its rate was checked`);
    }
});

// ── 2. Every adapter reports its own units ─────────────────────────────────

test('every adapter meters every capability it serves', () => {
    const gaps = [];
    for (const { provider, capability, adapter } of pairs()) {
        if (typeof adapter.meter !== 'function') { gaps.push(`${provider} has no meter()`); continue; }
        const usage = adapter.meter(capability, samplePayload(capability), sampleResult(capability, provider));
        if (!usage) { gaps.push(`${provider}:${capability} metered nothing`); continue; }
        if (!pricing.BILLING_UNITS.includes(usage.unit)) gaps.push(`${provider}:${capability} unit '${usage.unit}'`);
        if (!(Number(usage.quantity) > 0)) gaps.push(`${provider}:${capability} quantity ${usage.quantity}`);
    }
    assert.deepStrictEqual(gaps, [], `unmetered pairs record a cost of zero: ${gaps.join(', ')}`);
});

test('an adapter meters in the unit its rate is published in', () => {
    // Metering seconds against a per-token rate produces a number that is
    // wrong by orders of magnitude while still looking like money.
    for (const { provider, capability, adapter } of pairs()) {
        const rate = pricing.rateFor(provider, capability);
        const usage = adapter.meter(capability, samplePayload(capability), sampleResult(capability, provider));
        assert.strictEqual(usage.unit, rate.unit,
            `${provider}:${capability} meters '${usage.unit}' but is priced per '${rate.unit}'`);
    }
});

test('pricing a metered call yields a real amount for every pair', () => {
    // A self-hosted gateway genuinely costs nothing per call. It must price at
    // zero DELIBERATELY — flagged `self_hosted` — because an unpriced pair also
    // reports zero, and those two are the states this whole file exists to keep
    // apart.
    for (const { provider, capability, adapter } of pairs()) {
        const usage = adapter.meter(capability, samplePayload(capability), sampleResult(capability, provider));
        const priced = pricing.priceUsage({ provider, capability, ...usage });
        assert.ok(priced.priced, `${provider}:${capability} could not be priced at all`);
        if (priced.self_hosted) {
            assert.strictEqual(priced.amount_usd, 0, `${provider}:${capability} is self-hosted but charged money`);
        } else {
            assert.ok(priced.amount_usd > 0,
                `${provider}:${capability} priced at $${priced.amount_usd} for ${usage.quantity} ${usage.unit}`);
        }
    }
});

// ── 3. The meter actually writes, through the registry, for every capability ─

test('a metered generation records one usage event and one cost entry, per capability', async () => {
    const { db, generateId } = require('../db/database');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Spend Test');

    for (const capability of CAPABILITIES) {
        if (capability === 'stock') continue;
        const before = countRows(db, projectId);

        const stub = stubAdapter(capability);
        const wrapped = meter.meterAdapter(stub, { projectId });
        const result = await wrapped.generate(capability, samplePayload(capability), {});
        assert.ok(result.ok, `${capability}: stub generation failed`);

        const after = countRows(db, projectId);
        assert.strictEqual(after.usage - before.usage, 1,
            `${capability}: expected 1 usage event, got ${after.usage - before.usage}`);

        // A cost entry is MONEY, and the ledger is read by a person. lipsync
        // and post have no adapter but the self-hosted gateway, so they cost
        // nothing per call — and a stream of $0.00 rows is noise in a list
        // whose job is to show where the money went. The usage event above is
        // what keeps "the local gateway ran 40 of these" answerable.
        const priced = pricing.priceUsage({
            provider: stub.id, capability,
            ...stub.meter(capability, samplePayload(capability), sampleResult(capability, stub.id)),
        });
        const expectedEntries = priced.amount_usd > 0 ? 1 : 0;
        assert.strictEqual(after.cost - before.cost, expectedEntries,
            `${capability}: expected ${expectedEntries} cost entry, got ${after.cost - before.cost}`);
        if (expectedEntries === 0) {
            assert.ok(priced.self_hosted,
                `${capability} billed nothing but is not marked self-hosted — that is an unpriced pair wearing a zero`);
        }
    }

    const spend = meter.projectSpend(projectId);
    assert.ok(spend.total_usd > 0, 'total spend is zero after ten metered generations');
    assert.strictEqual(Object.keys(spend.by_capability).length, CAPABILITIES.length - 1);
});

test('a failed generation is not billed', () => {
    // A provider that refused produced nothing and charged nothing. Recording
    // it would make every moderation retry look like money spent.
    const { db, generateId } = require('../db/database');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Refusal Test');

    const failing = { id: 'runway', capabilities: ['video'], supports: () => true,
        generate: async () => ({ ok: false, status: 400, error: 'moderation' }),
        meter: providers.get('runway').meter };
    return meter.meterAdapter(failing, { projectId }).generate('video', samplePayload('video'), {})
        .then(() => {
            assert.strictEqual(countRows(db, projectId).usage, 0, 'a refused generation was billed');
        });
});

test('metering never fails a generation that already succeeded', async () => {
    // The call has been made and the money is gone. A meter that throws here
    // turns a paid, successful generation into an error the caller reports as
    // a failure — the worst possible trade.
    const { db, generateId } = require('../db/database');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Meter Fault');

    const hostile = { id: 'meshy', capabilities: ['image'], supports: () => true,
        generate: async () => ({ ok: true, data: { url: 'x' } }),
        meter: () => { throw new Error('meter exploded'); } };
    const result = await meter.meterAdapter(hostile, { projectId }).generate('image', samplePayload('image'), {});
    assert.strictEqual(result.ok, true, 'a throwing meter broke a successful generation');
});

// ── 4. No generation path bypasses the meter ───────────────────────────────

test('every generate() call site obtains its adapter from the registry', () => {
    // Metering is installed at resolve()/resolveGenerator(). A route that
    // reaches an adapter another way spends money the report cannot see, and
    // looks identical to one that does not spend at all.
    const roots = ['routes', 'lib'];
    const offenders = [];
    for (const root of roots) {
        for (const file of walk(path.join(__dirname, '..', root))) {
            if (file.includes(path.join('lib', 'providers'))) continue;   // inside the boundary
            const src = fs.readFileSync(file, 'utf8');
            if (!/\.generate(Stream)?\s*\(/.test(src)) continue;
            const rel = path.relative(path.join(__dirname, '..'), file);

            // Obtaining an adapter from the registry's resolve path is metered.
            const resolves = /resolveGenerator\s*\(|\bresolve\s*\(\s*['"]|providers\.(resolve|metered)/.test(src);
            // Being HANDED one is fine too — whoever resolved it metered it.
            // lib/reference-plates.js is the real instance: one plate generator
            // shared by locations and props, with the adapter injected.
            const injected = /function[^\n]*\bprovider\b[^\n]*\)|\bprovider\s*[,}]/.test(src)
                && !/providers\.list\s*\(\)[\s\S]{0,400}?\.generate/.test(src);
            // The one form that is always wrong: pulling a RAW adapter out of
            // the registry and generating with it. providers.list() and get()
            // bypass resolve(), which is where metering is installed.
            const raw = /(providers\.list\s*\(\)|providers\.get\s*\()[\s\S]{0,600}?\.generate(Stream)?\s*\(/.test(src);

            if (raw || !(resolves || injected)) offenders.push(rel);
        }
    }
    assert.deepStrictEqual(offenders, [], `these spend money outside the meter: ${offenders.join(', ')}`);
});

test('resolve() and resolveGenerator() hand back a metered adapter', () => {
    for (const capability of CAPABILITIES) {
        for (const fn of ['resolve', 'resolveGenerator']) {
            const adapter = providers[fn](capability, {});
            assert.ok(adapter.__metered === true,
                `${fn}('${capability}') returned an unmetered adapter`);
        }
    }
});

test('there is exactly one parseProjectConfig implementation', () => {
    // Seven identical copies is how the project id — which every one of them
    // already receives — failed to reach the meter for years.
    const copies = [];
    for (const root of ['routes', 'lib']) {
        for (const file of walk(path.join(__dirname, '..', root))) {
            const src = fs.readFileSync(file, 'utf8');
            if (/function parseProjectConfig\s*\(\s*projectId\s*\)/.test(src)) {
                copies.push(path.relative(path.join(__dirname, '..'), file));
            }
        }
    }
    assert.deepStrictEqual(copies, [], `duplicate provider-config readers: ${copies.join(', ')}`);
});

test('spend from a shot-scoped generation is attributed to that shot', () => {
    // "Which shot cost the most" is the question a per-shot budget exists for,
    // and it is answerable only if the live meter records a shot id. It did not:
    // callImageGen rebuilds its request body with a spread, which drops the
    // non-enumerable tag the payload was carrying — so every frame generated
    // through the board was attributed to the project and to no shot, and the
    // per-shot table populated only from a backfill.
    const { db, generateId } = require('../db/database');
    const { spendContext } = require('../lib/provider-config');

    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Attribution');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)').run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, duration_ms) VALUES (?, ?, ?, 4000)')
        .run(shotId, sceneId, '3C');

    // Exactly what a route does: build the context, resolve, generate.
    const ctx = spendContext({ id: projectId }, { id: shotId, scene_id: sceneId });
    const stub = { id: 'meshy', capabilities: ['image'], supports: () => true,
        meter: providers.get('meshy').meter,
        generate: async () => ({ ok: true, data: {}, provider_model: 'nano-banana-pro' }) };

    return meter.meterAdapter(stub, { projectId: ctx.__project_id, shotId: ctx.__shot_id, sceneId: ctx.__scene_id })
        .generate('image', { prompt: 'x' }, {})
        .then(() => {
            const row = db.prepare('SELECT shot_id, scene_id FROM film_usage_events WHERE project_id = ?').get(projectId);
            assert.strictEqual(row.shot_id, shotId, 'spend was not attributed to the shot that caused it');
            assert.strictEqual(row.scene_id, sceneId, 'spend was not attributed to the scene');
            const spend = meter.projectSpend(projectId);
            assert.strictEqual(spend.by_shot.length, 1, 'per-shot breakdown is empty');
            assert.strictEqual(spend.by_shot[0].shot_code, '3C');
        });
});

test('every shot-scoped generation route builds a spend context', () => {
    // Derived from the source, not listed here: a route that resolves a
    // provider while a shot or scene is in hand must attribute to it. One route
    // that does not is a silent hole in the per-shot report, and it looks
    // exactly like a shot nobody generated.
    const routes = ['storyboard.js', 'video-gen.js', 'voice.js', 'music-gen.js',
                    'lipsync.js', 'post-production.js'];
    const missing = [];
    for (const file of routes) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
        if (!/spendContext\s*\(/.test(src)) missing.push(`routes/${file}`);
    }
    assert.deepStrictEqual(missing, [], `these attribute spend to no shot: ${missing.join(', ')}`);
});

// ── 5. What the user actually asked to see ─────────────────────────────────

test('spend rolls up per project and per minute of footage', () => {
    const { db, generateId } = require('../db/database');
    const projectId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Rollup');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, ?)')
        .run(sceneId, projectId, 'TEST');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, duration_ms) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', 30000);

    meter.recordUsage({
        projectId, shotId, provider: 'runway', capability: 'video',
        model: 'gen4.5', unit: 'second', quantity: 10,
    });

    const spend = meter.projectSpend(projectId);
    assert.ok(spend.total_usd > 0, 'no spend recorded');
    assert.ok(spend.footage_seconds > 0, 'footage duration not measured');
    assert.ok(spend.usd_per_minute > 0, 'cost per minute of footage not computed');
    assert.ok(Math.abs(spend.usd_per_minute - spend.total_usd / (spend.footage_seconds / 60)) < 1e-9,
        'usd_per_minute does not follow from total spend and footage length');
});

test('historical spend can be reconstructed from assets that already exist', () => {
    // Wingfall generated 41 images before any of this existed. A tracker that
    // can only start from today reports $0 for the work already paid for.
    const { db, generateId } = require('../db/database');
    const { backfillProject } = require('../lib/spend-backfill');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(projectId, 'Backfill', JSON.stringify({ image: 'meshy' }));
    for (let i = 0; i < 3; i++) {
        db.prepare('INSERT INTO film_assets (id, project_id, asset_type, file_path) VALUES (?, ?, ?, ?)')
            .run(generateId(), projectId, 'storyboard', `/x/${i}.png`);
    }

    const first = backfillProject(projectId);
    assert.strictEqual(first.recorded, 3, `expected 3 reconstructed entries, got ${first.recorded}`);
    assert.ok(first.total_usd > 0);
    assert.ok(first.estimated === true, 'a reconstruction must be flagged as an estimate, not a measurement');

    // Idempotent: running it twice must not double the project's spend.
    const second = backfillProject(projectId);
    assert.strictEqual(second.recorded, 0, 'backfill double-counted on a second run');
});

// ── fixtures ───────────────────────────────────────────────────────────────

function samplePayload(capability) {
    switch (capability) {
        case 'llm':    return { question: 'x'.repeat(400), max_tokens: 1000 };
        case 'voice':  return { text: 'x'.repeat(500), voice_id: 'v' };
        case 'sfx':    return { text: 'a door slams', duration_s: 3 };
        case 'ambient':return { text: 'rain', duration_s: 20, bed_duration_s: 20 };
        case 'music':  return { prompt: 'strings', duration_ms: 60000 };
        case 'video':  return { prompt: 'a street', duration: 5, duration_s: 5 };
        case 'image':  return { prompt: 'a street', width: 1024, height: 1024 };
        case 'model3d':return { prompt: 'a chair' };
        case 'lipsync':return { video_url: 'v', audio_url: 'a', duration_ms: 5000 };
        case 'post':   return { video_url: 'v', operation: 'composite', duration_ms: 5000 };
        default:       return { prompt: 'x' };
    }
}

function sampleResult(capability, provider) {
    const base = { ok: true, data: {}, provider_model: '' };
    if (provider === 'anthropic') return { ...base, provider_model: 'claude-opus-5', usage: { input_tokens: 1200, output_tokens: 800 } };
    if (provider === 'openai')    return { ...base, provider_model: capability === 'llm' ? 'gpt-4.1' : 'gpt-image-1', usage: { prompt_tokens: 1000, completion_tokens: 500 } };
    if (provider === 'runway')    return { ...base, provider_model: capability === 'video' ? 'gen4.5' : 'gen4_image' };
    if (provider === 'meshy')     return { ...base, provider_model: capability === 'image' ? 'nano-banana-pro' : 'meshy-5' };
    if (provider === 'elevenlabs')return { ...base, provider_model: 'eleven_multilingual_v2' };
    return base;
}

function stubAdapter(capability) {
    const preferred = { llm: 'anthropic', image: 'meshy', video: 'runway', voice: 'elevenlabs',
        music: 'elevenlabs', sfx: 'elevenlabs', ambient: 'elevenlabs',
        model3d: 'meshy', lipsync: 'gridlight', post: 'gridlight' }[capability] || 'gridlight';
    const real = providers.get(preferred);
    return {
        id: real.id, capabilities: [capability], supports: () => true,
        meter: real.meter,
        generate: async () => sampleResult(capability, real.id),
    };
}

function countRows(db, projectId) {
    return {
        usage: db.prepare('SELECT COUNT(*) n FROM film_usage_events WHERE project_id = ?').get(projectId).n,
        cost: db.prepare('SELECT COUNT(*) n FROM film_cost_entries WHERE project_id = ?').get(projectId).n,
    };
}

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}
