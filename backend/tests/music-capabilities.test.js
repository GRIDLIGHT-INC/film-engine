const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * THE MUSIC CAPABILITY REGISTRY: SIX WORKFLOWS, EVERY PROVIDER ANSWERS FOR
 * EACH, AND "NO" IS AN ANSWER WITH A REASON.
 *
 * MUS-009. The engine had one music capability — a whole cue from a prompt —
 * and the workstation needs six ways of making music: compose a cue,
 * generate its native parts, separate a recording into stems, condition on
 * a reference, condition on the picture, regenerate a selected range. A
 * provider serves some and not others, and the difference is a fact about
 * the provider that has to be DISCOVERABLE before anything spends: a
 * workflow silently unsupported is a button that fails at the provider, a
 * refusal that reads like a credential problem.
 *
 * They are NOT six new top-level capabilities. A capability here is twelve
 * registries (the cost gate, the node types, the taxonomy, the rate book,
 * the readiness brief…) and five of these six have no provider that serves
 * them today — adding them there would be five nodes on the canvas and five
 * rate rows describing things that do not exist. They are workflows OF the
 * `music` capability: each provider serving `music` declares, per workflow,
 * whether it is available, planned or unsupported, with limits and a reason.
 *
 * Set-based over WORKFLOWS and over every adapter that serves `music`
 * (derived from providers.list(), never typed), because the failure is
 * partial by nature: a registry describing compose beautifully and leaving
 * inpaint undeclared reads as complete.
 */

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-mcap-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const caps = require('../lib/music-capabilities');
const providers = require('../lib/providers');
const contracts = require('../lib/music-session');
const pricing = require('../lib/provider-pricing');
const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');
const musicRoute = require('../routes/music-gen');

const EPIC_WORKFLOWS = ['music_compose', 'music_parts', 'music_separate', 'music_reference', 'music_video', 'music_inpaint'];
const musicAdapters = () => providers.list().filter(a => (a.capabilities || []).includes('music'));
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

// ── The registry itself ────────────────────────────────────────────────────

test('the six workflows the epic names, each with a plan schema, a result schema, an output kind and its limit fields', () => {
    assert.deepStrictEqual(Object.keys(caps.WORKFLOWS), EPIC_WORKFLOWS, 'the registry does not name exactly the six workflows');
    for (const [id, w] of Object.entries(caps.WORKFLOWS)) {
        assert.ok(w.what && w.what.length > 20, `${id}: no description`);
        assert.ok(caps.OUTPUT_KINDS[w.output_kind], `${id}: output kind ${w.output_kind} is not in the taxonomy`);
        assert.ok(Array.isArray(w.limit_fields) && w.limit_fields.length, `${id}: declares no limit fields`);
        assert.ok(w.plan && w.plan.fields && Object.keys(w.plan.fields).length >= 2, `${id}: no plan schema`);
        assert.ok(Object.values(w.plan.fields).some(f => f.required), `${id}: a plan with nothing required is not a plan`);
        assert.ok(w.result && w.result.fields && w.result.fields.outputs, `${id}: no result schema naming its outputs`);
        assert.ok(w.cost && w.cost.unit, `${id}: no cost unit`);
    }
});

test('the output taxonomy and the clip source kinds are one vocabulary, in both directions', () => {
    const sourceKinds = contracts.VOCABULARY['film_music_clips.source_kind'];
    for (const [kind, spec] of Object.entries(caps.OUTPUT_KINDS)) {
        assert.ok(sourceKinds.includes(spec.source_kind), `${kind} lands as source_kind '${spec.source_kind}', which the clip table refuses`);
        assert.ok(spec.what && spec.what.length > 10, `${kind}: no description`);
    }
    for (const sk of sourceKinds) {
        assert.ok(Object.values(caps.OUTPUT_KINDS).some(s => s.source_kind === sk), `clip source_kind '${sk}' is produced by no output kind`);
    }
    assert.deepStrictEqual(caps.STATUSES, ['available', 'planned', 'unsupported']);
});

// ── Every provider answers for every workflow ──────────────────────────────

test('every adapter that serves music declares all six workflows, and every non-available one says why', () => {
    const adapters = musicAdapters();
    assert.ok(adapters.length >= 2, `only ${adapters.length} music adapter(s) registered — the denominator is broken`);
    for (const a of adapters) {
        assert.ok(a.music && typeof a.music === 'object', `${a.id}: serves music and declares no music contract`);
        assert.deepStrictEqual(Object.keys(a.music).sort(), EPIC_WORKFLOWS.slice().sort(), `${a.id}: the contract does not answer for exactly the six workflows`);
        for (const [wf, decl] of Object.entries(a.music)) {
            assert.ok(caps.STATUSES.includes(decl.status), `${a.id}.${wf}: status '${decl.status}' is not one of ${caps.STATUSES.join('/')}`);
            if (decl.status !== 'available') assert.ok(decl.reason && decl.reason.length > 15, `${a.id}.${wf}: ${decl.status} with no reason`);
            if (decl.status === 'available') {
                assert.ok(decl.limits && typeof decl.limits === 'object', `${a.id}.${wf}: available with no limits`);
                for (const field of caps.WORKFLOWS[wf].limit_fields) {
                    assert.ok(decl.limits[field] !== undefined, `${a.id}.${wf}: available but declares no ${field}`);
                }
                assert.ok(decl.source, `${a.id}.${wf}: available with no source for its limits`);
            }
        }
        // A declaration is held to the module's own validator, so a typo in a
        // status or a missing limit fails HERE rather than at discovery time.
        const v = caps.validateContract(a.id, a.music);
        assert.deepStrictEqual(v.errors, [], `${a.id}: ${JSON.stringify(v.errors)}`);
    }
});

test('a contract that lies is refused by the validator: an unknown workflow, an unknown status, an available workflow with no limits', () => {
    const good = musicAdapters()[0].music;
    assert.deepStrictEqual(caps.validateContract('x', good).errors, []);
    assert.ok(caps.validateContract('x', { ...good, music_dance: { status: 'available' } }).errors.some(e => /music_dance/.test(e)), 'a seventh workflow passed');
    assert.ok(caps.validateContract('x', { ...good, music_compose: { status: 'maybe' } }).errors.some(e => /maybe/.test(e)), 'an unknown status passed');
    assert.ok(caps.validateContract('x', { ...good, music_compose: { status: 'available' } }).errors.some(e => /limits/.test(e)), 'available with no limits passed');
    const { music_inpaint, ...missing } = good; void music_inpaint;
    assert.ok(caps.validateContract('x', missing).errors.some(e => /music_inpaint/.test(e)), 'a missing workflow passed');
});

// ── Discovery, and the explicit "no" ───────────────────────────────────────

test('discovery answers every workflow for the project\'s own music provider, with limits, a cost hint and alternatives', () => {
    const ids = musicAdapters().map(a => a.id);
    for (const id of ids) {
        const out = caps.discoverMusicCapabilities({ music: id });
        assert.strictEqual(out.provider.id, id, `pinned to ${id}, discovered ${out.provider.id}`);
        assert.deepStrictEqual(out.workflows.map(w => w.workflow), EPIC_WORKFLOWS);
        for (const w of out.workflows) {
            const decl = providers.get(id).music[w.workflow];
            assert.strictEqual(w.status, decl.status, `${id}.${w.workflow}: discovery says ${w.status}, the contract says ${decl.status}`);
            assert.strictEqual(w.supported, decl.status === 'available');
            assert.ok(w.output_kind && w.source_kind, `${w.workflow}: no output taxonomy on the answer`);
            assert.ok(w.plan && w.result, `${w.workflow}: the schemas do not travel with the answer`);
            if (w.status !== 'available') assert.ok(w.reason, `${id}.${w.workflow}: no reason`);
            // A cost hint is the rate book's row or an honest null — never an invented number.
            if (w.cost_hint) {
                assert.ok(w.cost_hint.source && w.cost_hint.checked, `${w.workflow}: a cost hint with no source or date`);
                assert.strictEqual(w.cost_hint.unit, caps.WORKFLOWS[w.workflow].cost.unit);
            } else assert.match(w.cost_note || '', /no rate|not priced|subscription|bills nothing/i, `${w.workflow}: no cost hint and no reason`);
            assert.ok(Array.isArray(w.alternatives), 'no alternatives list');
            for (const alt of w.alternatives) assert.notStrictEqual(alt.id, id, 'the provider itself is listed as an alternative to itself');
        }
    }
    // The cost hint for compose on ElevenLabs is the rate book's own row.
    const el = caps.discoverMusicCapabilities({ music: 'elevenlabs' }).workflows.find(w => w.workflow === 'music_compose');
    const rate = pricing.rateFor('elevenlabs', 'music');
    assert.ok(el.cost_hint && Math.abs(el.cost_hint.usd_per_unit - rate.usd_per_unit) < 1e-9, 'the compose cost hint is not the rate book');
});

test('a workflow the provider does not serve is an explicit refusal naming the provider, the reason and who else could', () => {
    const out = caps.discoverMusicCapabilities({ music: 'elevenlabs' });
    const missing = out.workflows.filter(w => !w.supported);
    assert.ok(missing.length >= 1, 'every workflow available on one provider is not a realistic registry');
    for (const w of missing) {
        const r = caps.unsupported(w.workflow, { music: 'elevenlabs' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.code, 'UNSUPPORTED');
        assert.strictEqual(r.workflow, w.workflow);
        assert.strictEqual(r.provider, 'elevenlabs');
        assert.strictEqual(r.status, w.status);
        assert.match(r.error, new RegExp(w.workflow.replace('music_', '')), 'the refusal does not name the workflow');
        assert.match(r.error, /elevenlabs/, 'the refusal does not name the provider');
        assert.ok(Array.isArray(r.alternatives));
    }
    // A supported workflow is not refused.
    const okOne = out.workflows.find(w => w.supported);
    assert.ok(okOne, 'ElevenLabs supports nothing?');
    assert.strictEqual(caps.unsupported(okOne.workflow, { music: 'elevenlabs' }), null);
    // A provider that serves no music at all: every workflow refused, naming it.
    const none = caps.discoverMusicCapabilities({ music: 'runway' });
    assert.ok(none.workflows.every(w => !w.supported && /runway/.test(w.reason)), 'a non-music provider was not refused for every workflow');
});

// ── Plans are validated against the provider's own limits ──────────────────

test('every workflow refuses a plan missing a required field, and one outside the provider\'s limits, naming the field', () => {
    const contract = providers.get('elevenlabs').music;
    for (const [wf, w] of Object.entries(caps.WORKFLOWS)) {
        const required = Object.entries(w.plan.fields).filter(([, f]) => f.required).map(([k]) => k);
        const empty = caps.validatePlan(wf, {}, contract[wf]);
        assert.strictEqual(empty.ok, false, `${wf}: an empty plan validated`);
        for (const r of required) assert.ok(empty.errors.some(e => e.field === r), `${wf}: missing '${r}' was not named`);
    }
    // Compose past the provider's ceiling.
    const longCompose = caps.validatePlan('music_compose', { session_id: 'S', prompt: 'a', duration_ms: contract.music_compose.limits.max_ms + 1 }, contract.music_compose);
    assert.ok(longCompose.errors.some(e => e.field === 'duration_ms' && /max/.test(e.message)), 'a cue longer than the provider allows validated');
    const fine = caps.validatePlan('music_compose', { session_id: 'S', prompt: 'a', duration_ms: 30000 }, contract.music_compose);
    assert.deepStrictEqual(fine.errors, [], JSON.stringify(fine.errors));
    // Inpaint with an inverted range.
    const inv = caps.validatePlan('music_inpaint', { session_id: 'S', clip_id: 'C', prompt: 'a', range: { start_ms: 5000, end_ms: 1000 } }, { status: 'available', limits: { max_range_ms: 60000, context_ms: 5000 } });
    assert.ok(inv.errors.some(e => e.field === 'range'), 'an inverted inpaint range validated');
    // Separate into a stem count the provider does not offer.
    const sep = caps.validatePlan('music_separate', { session_id: 'S', asset_id: 'A', stems: 4 }, { status: 'available', limits: { stem_counts: [2, 6], max_input_ms: 600000, input_formats: ['wav'] } });
    assert.ok(sep.errors.some(e => e.field === 'stems' && /2, 6/.test(e.message)), 'a stem count outside the list validated');
});

// ── Every call site of the music capability is named ───────────────────────

test('every place that resolves the music capability is in the call-site registry with the workflow it performs, and nothing stale', () => {
    const found = [];
    for (const dir of ['routes', 'lib']) {
        for (const f of fs.readdirSync(path.join(__dirname, '..', dir)).filter(x => x.endsWith('.js'))) {
            const rel = `${dir}/${f}`;
            if (rel === 'lib/music-capabilities.js') continue;
            const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
            for (const m of src.matchAll(/resolve(?:Generator)?\(\s*'music'/g)) {
                const fn = [...src.slice(0, m.index).matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop();
                found.push(`${rel}:${fn ? fn[1] : '(top level)'}`);
            }
        }
    }
    assert.ok(found.length >= 3, `only ${found.length} music call sites found — the scan is broken`);
    const registered = caps.MUSIC_CALL_SITES.map(c => `${c.file}:${c.fn}`);
    assert.deepStrictEqual([...new Set(found)].sort(), registered.slice().sort(), 'the call-site registry and the code disagree about who resolves the music capability');
    for (const c of caps.MUSIC_CALL_SITES) for (const wf of (c.workflows || [c.workflow])) assert.ok(caps.WORKFLOWS[wf], `${c.file}:${c.fn} performs '${wf}', which is not a workflow`);
});

// ── Served, and reachable ──────────────────────────────────────────────────

function call(method, url, body) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, writeHead(c) { this.statusCode = c; return this; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p || '{}') }); } };
        Promise.resolve(musicRoute.handleMusicGen({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean), {})).catch(reject);
    });
}

test('discovery is served per project, reachable over MCP for free, and shown on the workstation', async () => {
    const pid = generateId();
    db.prepare("INSERT INTO film_projects (id, title, provider_config) VALUES (?, 'C', ?)").run(pid, JSON.stringify({ music: 'elevenlabs' }));
    const res = await call('GET', `/film/projects/${pid}/music/capabilities`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    assert.strictEqual(res.body.provider.id, 'elevenlabs');
    assert.deepStrictEqual(res.body.workflows.map(w => w.workflow), EPIC_WORKFLOWS);
    assert.strictEqual((await call('GET', `/film/projects/${generateId()}/music/capabilities`)).status, 404);

    const t = PRODUCTION_TOOLS.find(x => x.name === 'music_capabilities');
    assert.ok(t, 'no music_capabilities tool');
    assert.strictEqual(t.method, 'GET');
    assert.match(t.description, /free|spends nothing/i);
    assert.match(t.description, /unsupported|planned/i, 'the tool does not say a workflow may be unsupported');
    assert.strictEqual(t.path({ project_id: 'P' }), '/film/projects/P/music/capabilities');

    const panel = /function mwProviderHtml\s*\(/.exec(SPA);
    assert.ok(panel, 'the workstation has no provider panel');
    const body = SPA.slice(panel.index, panel.index + 3000);
    assert.match(body, /workflows/, 'the panel does not read the workflows');
    assert.match(body, /status/, 'the panel does not show each workflow\'s status');
    assert.match(body, /reason/, 'the panel hides why a workflow is unsupported');
    const load = SPA.slice(SPA.indexOf('async function mwLoadSession'), SPA.indexOf('async function mwLoadSession') + 2500);
    assert.match(load, /music\/capabilities/, 'the session loader never asks what the provider can do');
});
